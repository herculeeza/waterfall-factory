// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title Waterfall - Revenue distribution contract
 * @dev Cap-based waterfall: tiers process in priority order until uncapped tier consumes remaining
 *
 * CORE LOGIC:
 * - Supports ETH (paymentToken = address(0)) or any ERC20 token
 * - Capped tiers (maxAmount > 0): Distribute up to cap, cascade remainder
 * - Uncapped tier (maxAmount = 0): Consumes all remaining revenue forever
 * - All tiers distribute proportionally to token holders
 * - Platform fee is skimmed on deposit before waterfall distribution
 *
 * SECURITY:
 * - Dividend tracking prevents earnings from transferring with tokens
 * - Sender must withdraw before transfer; receiver's position is accrued
 * - Reentrancy protection on all state-changing operations
 * - Pausable for emergency stops
 *
 * NOTE: Fee-on-transfer and rebasing ERC20 tokens are not fully supported.
 *       Inbound transfers are measured by balance delta, but outbound fee-on-transfer
 *       tokens may result in recipients receiving less than the contract records.
 *
 * NOTE: This contract does not override supportsInterface beyond ERC1155's default.
 *       Custom functions (rescue, waterfall distribution) are not discoverable via ERC165.
 *
 * NOTE: The number of tiers is bounded by uint8 priority (max 256) and practically
 *       by block gas limits (~20-50 tiers depending on chain). The number of holders
 *       per createPriority call is similarly bounded by gas (~200-500 depending on chain).
 */
contract Waterfall is ERC1155, Ownable, ReentrancyGuard, Pausable {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    // --- Custom Errors ---
    error FeeExceedsMax();
    error FeeRecipientRequired();
    error UnsafeJsonString();
    error AlreadyFinalized();
    error NotFinalized();
    error UncappedTierExists();
    error MustHaveUncappedTier();
    error UncappedTierNotLast();
    error ArrayLengthMismatch();
    error NoHolders();
    error ZeroTotalSupply();
    error ZeroAmount();
    error TokenIdExists();
    error PriorityExists();
    error ZeroAddressHolder();
    error AmountsSumMismatch();
    error ZeroDeposit();
    error AmountNotAllowedForETH();
    error ETHNotAllowedForToken();
    error UseDepositRevenueWithAmount();
    error NoTokensOwned();
    error NoFundsAvailable();
    error MustWithdrawBeforeTransfer();
    error TokenDoesNotExist();
    error ETHTransferFailed();
    error CannotRescuePaymentToken();
    error CannotRescueETH();
    error NotERC20Waterfall();
    error UseDepositRevenue();
    error NoEscrowedFees();

    struct PriorityLevel {
        bool exists;
        uint256 totalSupply;
        uint256 maxAmount;  // 0 = uncapped (final tier), >0 = cap
        uint256 totalEarned;
        uint256 totalWithdrawn;
        uint256 cumulativeEarnedPerToken;  // Scaled by PRECISION
        uint256 dustRemainder;  // Rounding dust from (payment * PRECISION) % totalSupply
    }

    uint256 private constant PRECISION = 1e27;

    string public projectName;

    string public imageURI;

    uint256 public totalRevenue;      // Net revenue after fees
    uint256 public totalDistributed;  // Sum of all tier totalEarned
    uint256 public totalWithdrawn;
    uint256 public totalFeesCollected;

    /// @notice Payment token: address(0) = native ETH, otherwise ERC20
    address public immutable paymentToken;

    // Platform fee: skimmed on deposit, forwarded to feeRecipient
    address public feeRecipient;
    uint256 public immutable feeBps;  // Basis points (500 = 5%)
    uint256 public escrowedFees;  // Fees that failed to transfer, claimable later

    uint256[] public tierTokenIds;  // Sorted by priority
    mapping(uint256 => uint8) public tierPriorities;
    mapping(uint256 => PriorityLevel) public priorityLevels;

    // Holder tracking: append-only list per tier (filter zero balances off-chain)
    mapping(uint256 => address[]) private _tierHolders;
    mapping(uint256 => mapping(address => bool)) private _isHolder;

    // Dividend tracking: snapshot when user last withdrew
    mapping(address => mapping(uint256 => uint256)) public userLastCumulativeEarnings;
    mapping(address => mapping(uint256 => uint256)) public accruedEarnings;

    // Prevents creating multiple uncapped tiers (only the first would receive funds)
    bool private _hasUncappedTier;

    bool public finalized;

    // Events
    event PriorityCreated(uint256 indexed tokenId, uint8 priority, uint256 totalSupply, uint256 maxAmount);
    event WaterfallFinalized(uint256 tierCount);
    event RevenueDeposited(address indexed depositor, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 totalRevenueAfter);
    event FundsWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount);
    event DistributionCalculated(uint256 totalDistributedAmount);
    event EarningsAccrued(address indexed user, uint256 indexed tokenId, uint256 amount);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event ETHRescued(address indexed to, uint256 amount);
    event ImageURIUpdated(string newURI);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event FeeEscrowed(uint256 amount, uint256 totalEscrowed);
    event EscrowedFeesClaimed(address indexed recipient, uint256 amount);

    /// @param _projectName Display name for the project (must not contain ", \, or control chars)
    /// @param _paymentToken Payment token address (address(0) for native ETH)
    /// @param _feeRecipient Address that receives platform fees (address(0) to disable fees)
    /// @param _feeBps Fee in basis points (e.g. 500 = 5%, max 1000 = 10%)
    constructor(
        string memory _projectName,
        address _paymentToken,
        address _feeRecipient,
        uint256 _feeBps
    ) ERC1155("") Ownable(msg.sender) {
        if (_feeBps > 1000) revert FeeExceedsMax();
        if (_feeBps > 0 && _feeRecipient == address(0)) revert FeeRecipientRequired();
        _validateJsonString(_projectName);
        projectName = _projectName;
        paymentToken = _paymentToken;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    /// @notice Reject direct ETH transfers — use depositRevenue() instead
    receive() external payable {
        revert UseDepositRevenue();
    }

    // --- Admin Functions ---

    /// @notice Pause deposits, withdrawals, and transfers
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the contract
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Set the image URI for token metadata
    /// @param _imageURI Image URL (must not contain ", \, or control chars)
    function setImageURI(string calldata _imageURI) external onlyOwner {
        _validateJsonString(_imageURI);
        imageURI = _imageURI;
        emit ImageURIUpdated(_imageURI);
    }

    /// @notice Update the fee recipient address
    /// @param _feeRecipient New fee recipient (cannot be address(0) if feeBps > 0)
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (feeBps > 0 && _feeRecipient == address(0)) revert FeeRecipientRequired();
        address old = feeRecipient;
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(old, _feeRecipient);
    }

    /// @notice Claim fees that failed to transfer to feeRecipient
    function claimEscrowedFees() external nonReentrant {
        uint256 amount = escrowedFees;
        if (amount == 0) revert NoEscrowedFees();
        escrowedFees = 0;
        _transferOut(feeRecipient, amount);
        emit EscrowedFeesClaimed(feeRecipient, amount);
    }

    /// @notice Create a new tier in the waterfall
    /// @param tokenId Unique token ID
    /// @param priority Priority level (0 = highest, processes first)
    /// @param totalSupply Total tokens to mint (must equal sum of amounts)
    /// @param maxAmount Revenue cap (0 = uncapped final tier)
    /// @param holders Token recipients (bounded by block gas limit, ~200-500 practical max)
    /// @param amounts Tokens per recipient (must sum to totalSupply, each must be > 0)
    function createPriority(
        uint256 tokenId,
        uint8 priority,
        uint256 totalSupply,
        uint256 maxAmount,
        address[] calldata holders,
        uint256[] calldata amounts
    ) external onlyOwner {
        if (finalized) revert AlreadyFinalized();
        if (holders.length != amounts.length) revert ArrayLengthMismatch();
        if (holders.length == 0) revert NoHolders();
        if (totalSupply == 0) revert ZeroTotalSupply();
        if (priorityLevels[tokenId].exists) revert TokenIdExists();

        uint256 sum = 0;
        for (uint256 i = 0; i < holders.length; i++) {
            if (holders[i] == address(0)) revert ZeroAddressHolder();
            if (amounts[i] == 0) revert ZeroAmount();
            sum += amounts[i];
        }
        if (sum != totalSupply) revert AmountsSumMismatch();

        // Enforce unique priority values to prevent ambiguous ordering
        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            if (tierPriorities[tierTokenIds[i]] == priority) revert PriorityExists();
        }

        // Only one uncapped tier allowed — a second would silently never receive funds
        if (maxAmount == 0) {
            if (_hasUncappedTier) revert UncappedTierExists();
            _hasUncappedTier = true;
        }

        priorityLevels[tokenId] = PriorityLevel({
            exists: true,
            totalSupply: totalSupply,
            maxAmount: maxAmount,
            totalEarned: 0,
            totalWithdrawn: 0,
            cumulativeEarnedPerToken: 0,
            dustRemainder: 0
        });

        tierTokenIds.push(tokenId);
        tierPriorities[tokenId] = priority;
        _sortTiers();

        // Mint tokens to holders and track them
        for (uint256 i = 0; i < holders.length; i++) {
            if (!_isHolder[tokenId][holders[i]]) {
                _isHolder[tokenId][holders[i]] = true;
                _tierHolders[tokenId].push(holders[i]);
            }
            _mint(holders[i], tokenId, amounts[i], "");
        }

        emit PriorityCreated(tokenId, priority, totalSupply, maxAmount);
    }

    /// @notice Lock the tier structure — no new tiers can be added after this
    /// @dev Requires an uncapped tier, and it must have the highest priority value
    ///      (last in processing order). Tiers after the uncapped tier would be dead weight.
    function finalize() external onlyOwner {
        if (finalized) revert AlreadyFinalized();
        if (!_hasUncappedTier) revert MustHaveUncappedTier();

        // Uncapped tier must be last in sorted order (highest priority value)
        uint256 lastTokenId = tierTokenIds[tierTokenIds.length - 1];
        if (priorityLevels[lastTokenId].maxAmount != 0) revert UncappedTierNotLast();

        finalized = true;
        emit WaterfallFinalized(tierTokenIds.length);
    }

    // --- Deposit Functions ---

    /// @notice Deposit revenue to be distributed through waterfall
    /// @dev For ETH: send value with call. For ERC20: approve then call with amount.
    ///      Platform fee is skimmed first; net amount enters the waterfall.
    /// @param amount Amount to deposit (only used for ERC20; must be 0 for ETH)
    function depositRevenue(uint256 amount) external payable nonReentrant whenNotPaused {
        if (!finalized) revert NotFinalized();

        uint256 gross;
        if (paymentToken == address(0)) {
            if (msg.value == 0) revert ZeroDeposit();
            if (amount != 0) revert AmountNotAllowedForETH();
            gross = msg.value;
        } else {
            if (msg.value != 0) revert ETHNotAllowedForToken();
            if (amount == 0) revert ZeroDeposit();
            // Measure actual balance delta to handle fee-on-transfer tokens
            uint256 balanceBefore = IERC20(paymentToken).balanceOf(address(this));
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
            gross = IERC20(paymentToken).balanceOf(address(this)) - balanceBefore;
            if (gross == 0) revert ZeroDeposit();
        }

        _handleDeposit(gross);
    }

    /// @notice Convenience overload for ETH deposits (no amount parameter needed)
    function depositRevenue() external payable nonReentrant whenNotPaused {
        if (!finalized) revert NotFinalized();
        if (paymentToken != address(0)) revert UseDepositRevenueWithAmount();
        if (msg.value == 0) revert ZeroDeposit();
        _handleDeposit(msg.value);
    }

    // --- Withdrawal Functions ---

    /// @notice Withdraw your earnings for a specific token
    /// @param tokenId The tier token ID to withdraw from
    function withdraw(uint256 tokenId) external nonReentrant whenNotPaused {
        uint256 balance = balanceOf(msg.sender, tokenId);
        if (balance == 0) revert NoTokensOwned();

        uint256 available = getAvailableBalance(msg.sender, tokenId);
        if (available == 0) revert NoFundsAvailable();

        PriorityLevel storage level = priorityLevels[tokenId];

        // Update user's withdrawal snapshot to current cumulative earnings
        userLastCumulativeEarnings[msg.sender][tokenId] = level.cumulativeEarnedPerToken;

        accruedEarnings[msg.sender][tokenId] = 0;

        // Update level totals
        level.totalWithdrawn += available;
        totalWithdrawn += available;

        _transferOut(msg.sender, available);

        emit FundsWithdrawn(msg.sender, tokenId, available);
    }

    /// @notice Withdraw earnings from multiple tokens in one transaction
    /// @dev Passing an empty array or duplicate IDs is harmless (no-op / second pass finds 0 available)
    /// @param tokenIds Array of tier token IDs to withdraw from
    function withdrawBatch(uint256[] calldata tokenIds) external nonReentrant whenNotPaused {
        uint256 totalAmount = 0;

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            uint256 balance = balanceOf(msg.sender, tokenId);

            if (balance > 0) {
                uint256 available = getAvailableBalance(msg.sender, tokenId);

                if (available > 0) {
                    PriorityLevel storage level = priorityLevels[tokenId];

                    userLastCumulativeEarnings[msg.sender][tokenId] = level.cumulativeEarnedPerToken;
                    accruedEarnings[msg.sender][tokenId] = 0;

                    level.totalWithdrawn += available;
                    totalWithdrawn += available;
                    totalAmount += available;

                    emit FundsWithdrawn(msg.sender, tokenId, available);
                }
            }
        }

        if (totalAmount > 0) {
            _transferOut(msg.sender, totalAmount);
        }
    }

    // --- View Functions ---

    /// @notice Get withdrawable balance for user and token (new earnings + accrued)
    /// @param user Address of the token holder
    /// @param tokenId The tier token ID
    /// @return Withdrawable amount in payment token units
    function getAvailableBalance(address user, uint256 tokenId) public view returns (uint256) {
        uint256 balance = balanceOf(user, tokenId);
        if (balance == 0) return accruedEarnings[user][tokenId];

        PriorityLevel memory level = priorityLevels[tokenId];
        if (!level.exists) return 0;

        uint256 lastSnapshot = userLastCumulativeEarnings[user][tokenId];
        uint256 newEarningsPerToken = level.cumulativeEarnedPerToken - lastSnapshot;
        uint256 newEarnings = (balance * newEarningsPerToken) / PRECISION;
        newEarnings += accruedEarnings[user][tokenId];

        return newEarnings;
    }

    /// @notice Get total withdrawable balance for a user across all tiers
    /// @param user Address of the token holder
    /// @return total Sum of available balances across all tiers
    function getTotalAvailable(address user) external view returns (uint256 total) {
        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            total += getAvailableBalance(user, tierTokenIds[i]);
        }
    }

    /// @notice Get the accounting balance (total revenue minus total withdrawn)
    /// @dev Compare with getContractBalance() to detect discrepancies from
    ///      force-sent ETH/tokens or rounding dust
    /// @return Accounting balance in payment token units
    function getAccountingBalance() external view returns (uint256) {
        return totalRevenue - totalWithdrawn;
    }

    /// @notice Get the actual contract balance of the payment token
    /// @dev May differ from getAccountingBalance() due to force-sent funds or rounding dust
    /// @return Actual balance held by this contract
    function getContractBalance() external view returns (uint256) {
        if (paymentToken == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(paymentToken).balanceOf(address(this));
        }
    }

    /// @notice Get token metadata URI (on-chain JSON)
    /// @param tokenId The tier token ID
    /// @return Data URI with base64-encoded JSON metadata
    function uri(uint256 tokenId) public view override returns (string memory) {
        PriorityLevel memory level = priorityLevels[tokenId];
        if (!level.exists) revert TokenDoesNotExist();

        uint256 priority = uint256(tierPriorities[tokenId]);

        string memory tierType = level.maxAmount == 0 ? "Uncapped" : "Capped";
        string memory tierDescription = level.maxAmount == 0
            ? "Uncapped tier - receives all remaining revenue"
            : "Capped tier - receives revenue up to cap";

        bytes memory imageField = bytes(imageURI).length > 0
            ? abi.encodePacked('"image":"', imageURI, '",')
            : bytes("");

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(string(abi.encodePacked(
                '{"name":"', projectName, ' - Priority ', priority.toString(), ' (', tierType, ')",',
                '"description":"', tierDescription, ' in ', projectName, ' waterfall at priority level ', priority.toString(), '",',
                imageField,
                '"attributes":[',
                    '{"trait_type":"Priority","value":', priority.toString(), '},',
                    '{"trait_type":"Tier Type","value":"', tierType, '"},',
                    '{"trait_type":"Max Amount","value":"', level.maxAmount.toString(), '"},',
                    '{"trait_type":"Total Supply","value":"', level.totalSupply.toString(), '"}',
                ']}'
            ))))
        ));
    }

    /// @notice Get all addresses that have ever held tokens for a tier
    /// @dev Append-only: may include zero-balance addresses. Filter off-chain via balanceOf.
    /// @param tokenId The tier token ID
    /// @return Array of all historical holder addresses
    function getHolders(uint256 tokenId) external view returns (address[] memory) {
        return _tierHolders[tokenId];
    }

    /// @notice Get holders for a tier with pagination
    /// @param tokenId The tier token ID
    /// @param offset Starting index
    /// @param limit Maximum number of addresses to return
    /// @return Slice of the holder array
    function getHolders(uint256 tokenId, uint256 offset, uint256 limit) external view returns (address[] memory) {
        address[] storage holders = _tierHolders[tokenId];
        if (offset >= holders.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > holders.length) end = holders.length;
        uint256 count = end - offset;
        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = holders[offset + i];
        }
        return result;
    }

    /// @notice Get all tier token IDs in priority order
    /// @return Array of token IDs sorted by priority (ascending)
    function getAllTiers() external view returns (uint256[] memory) {
        return tierTokenIds;
    }

    /// @notice Get detailed info about a priority tier
    /// @param tokenId The tier token ID
    /// @return exists Whether the tier exists
    /// @return priority The tier's priority level (0 = highest)
    /// @return tierTotalSupply Total token supply for this tier
    /// @return maxAmount Revenue cap (0 = uncapped)
    /// @return totalEarned Total revenue allocated to this tier
    /// @return tierWithdrawn Total revenue withdrawn from this tier
    /// @return available Revenue allocated but not yet withdrawn
    function getPriorityInfo(uint256 tokenId) external view returns (
        bool exists,
        uint8 priority,
        uint256 tierTotalSupply,
        uint256 maxAmount,
        uint256 totalEarned,
        uint256 tierWithdrawn,
        uint256 available
    ) {
        PriorityLevel memory level = priorityLevels[tokenId];
        return (
            level.exists,
            tierPriorities[tokenId],
            level.totalSupply,
            level.maxAmount,
            level.totalEarned,
            level.totalWithdrawn,
            level.totalEarned > level.totalWithdrawn ? level.totalEarned - level.totalWithdrawn : 0
        );
    }

    // --- Rescue Functions ---

    /// @notice Rescue accidentally-sent ERC20 tokens (cannot rescue the payment token)
    /// @param token The ERC20 token to rescue
    /// @param to Recipient address
    /// @param amount Amount to rescue
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert CannotRescueETH();
        if (token == paymentToken) revert CannotRescuePaymentToken();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    /// @notice Rescue force-sent ETH from ERC20-denominated waterfalls
    /// @param to Recipient address
    function rescueETH(address to) external onlyOwner {
        if (paymentToken == address(0)) revert NotERC20Waterfall();
        uint256 balance = address(this).balance;
        (bool success, ) = payable(to).call{value: balance}("");
        if (!success) revert ETHTransferFailed();
        emit ETHRescued(to, balance);
    }

    // --- Internal Functions ---

    /// @dev Process a deposit: skim fee, update revenue, distribute, then transfer fee
    ///      Fee transfer is last to follow checks-effects-interactions pattern.
    function _handleDeposit(uint256 gross) internal {
        uint256 fee = 0;
        if (feeBps > 0) {
            fee = (gross * feeBps) / 10000;
            totalFeesCollected += fee;
        }

        uint256 net = gross - fee;
        totalRevenue += net;
        _calculateDistribution();

        // Transfer fee after all state updates (checks-effects-interactions)
        // Escrow on failure so a reverting feeRecipient can't block deposits
        if (fee > 0) {
            if (paymentToken == address(0)) {
                (bool success, ) = payable(feeRecipient).call{value: fee}("");
                if (!success) {
                    escrowedFees += fee;
                    emit FeeEscrowed(fee, escrowedFees);
                }
            } else {
                // ERC20 safeTransfer reverts on failure — wrap in try/catch
                try IERC20(paymentToken).transfer(feeRecipient, fee) returns (bool success) {
                    if (!success) {
                        escrowedFees += fee;
                        emit FeeEscrowed(fee, escrowedFees);
                    }
                } catch {
                    escrowedFees += fee;
                    emit FeeEscrowed(fee, escrowedFees);
                }
            }
        }

        emit RevenueDeposited(msg.sender, gross, fee, net, totalRevenue);
    }

    /// @dev Process revenue through tiers: capped tiers cascade, uncapped consumes all
    function _calculateDistribution() internal {
        uint256 undistributed = totalRevenue - totalDistributed;
        if (undistributed == 0) return;

        uint256 remaining = undistributed;

        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            if (remaining == 0) break;

            uint256 tokenId = tierTokenIds[i];
            remaining = _distributeTo(tokenId, remaining);

            if (priorityLevels[tokenId].maxAmount == 0) break;
        }

        totalDistributed += (undistributed - remaining);
        emit DistributionCalculated(undistributed - remaining);
    }

    /// @dev Allocate revenue to tier (capped = up to limit, uncapped = all remaining)
    ///      Rounding dust from integer division is carried forward in dustRemainder
    ///      so it accumulates and gets credited on subsequent deposits.
    function _distributeTo(uint256 tokenId, uint256 available) internal returns (uint256) {
        PriorityLevel storage level = priorityLevels[tokenId];

        if (level.maxAmount > 0) {
            // Capped tier: distribute up to maxAmount
            uint256 alreadyEarned = level.totalEarned;
            uint256 remaining = level.maxAmount > alreadyEarned ? level.maxAmount - alreadyEarned : 0;

            if (remaining == 0) return available; // Tier fulfilled, move to next

            uint256 payment = available < remaining ? available : remaining;
            level.totalEarned += payment;
            _creditEarningsPerToken(level, payment);

            return available - payment;
        } else {
            // Uncapped tier (final tier): consume all remaining revenue
            level.totalEarned += available;
            _creditEarningsPerToken(level, available);

            return 0;
        }
    }

    /// @dev Credit earnings per token with dust carry-forward to prevent rounding loss
    function _creditEarningsPerToken(PriorityLevel storage level, uint256 payment) internal {
        uint256 scaled = payment * PRECISION + level.dustRemainder;
        level.cumulativeEarnedPerToken += scaled / level.totalSupply;
        level.dustRemainder = scaled % level.totalSupply;
    }

    /// @dev Handle dividend accounting for a single token during transfer
    function _handleTransferAccounting(address from, address to, uint256 tokenId) internal {
        PriorityLevel memory level = priorityLevels[tokenId];
        if (!level.exists) return;
        _requireNoSenderEarnings(from, tokenId, level.cumulativeEarnedPerToken);
        _accrueReceiverEarnings(to, tokenId, level.cumulativeEarnedPerToken);
    }

    /// @dev Require sender has no pending earnings (new or accrued) for a token
    function _requireNoSenderEarnings(address from, uint256 tokenId, uint256 cumulativeEPT) internal view {
        uint256 senderBalance = balanceOf(from, tokenId);
        uint256 senderSnapshot = userLastCumulativeEarnings[from][tokenId];
        uint256 senderNewEarnings = (senderBalance * (cumulativeEPT - senderSnapshot)) / PRECISION;
        if (senderNewEarnings != 0 || accruedEarnings[from][tokenId] != 0) {
            revert MustWithdrawBeforeTransfer();
        }
    }

    /// @dev Accrue receiver's existing earnings and update snapshot for a token
    function _accrueReceiverEarnings(address to, uint256 tokenId, uint256 cumulativeEPT) internal {
        uint256 receiverBalance = balanceOf(to, tokenId);
        if (receiverBalance > 0) {
            uint256 receiverSnapshot = userLastCumulativeEarnings[to][tokenId];
            uint256 receiverCurrentEarnings = (receiverBalance * (cumulativeEPT - receiverSnapshot)) / PRECISION;
            accruedEarnings[to][tokenId] += receiverCurrentEarnings;
            emit EarningsAccrued(to, tokenId, receiverCurrentEarnings);
        }
        userLastCumulativeEarnings[to][tokenId] = cumulativeEPT;
    }

    /// @dev Transfer hook: prevent earnings from moving with tokens, track new holders
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal virtual override whenNotPaused {
        // Pre-transfer dividend protection (before balances change)
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                _handleTransferAccounting(from, to, ids[i]);
            }
        }

        super._update(from, to, ids, values);

        // Track new holders (append-only — stale entries filtered off-chain via balanceOf)
        if (to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                if (!_isHolder[ids[i]][to]) {
                    _isHolder[ids[i]][to] = true;
                    _tierHolders[ids[i]].push(to);
                }
            }
        }
    }

    /// @dev Transfer ETH or ERC20 to recipient
    function _transferOut(address to, uint256 amount) internal {
        if (paymentToken == address(0)) {
            (bool success, ) = payable(to).call{value: amount}("");
            if (!success) revert ETHTransferFailed();
        } else {
            IERC20(paymentToken).safeTransfer(to, amount);
        }
    }

    /// @dev Sort tiers by priority (insertion from end — O(n) since only one new element)
    function _sortTiers() internal {
        uint256 n = tierTokenIds.length;
        if (n <= 1) return;

        uint256 i = n - 1;
        while (i > 0 && tierPriorities[tierTokenIds[i - 1]] > tierPriorities[tierTokenIds[i]]) {
            uint256 temp = tierTokenIds[i];
            tierTokenIds[i] = tierTokenIds[i - 1];
            tierTokenIds[i - 1] = temp;
            i--;
        }
    }

    /// @dev Validate string contains no JSON-unsafe characters (quotes, backslashes, control chars)
    function _validateJsonString(string memory value) internal pure {
        bytes memory b = bytes(value);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < 0x20 || b[i] == '"' || b[i] == '\\') revert UnsafeJsonString();
        }
    }
}
