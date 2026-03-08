// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

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
 * - Reentrancy protection on all withdrawals
 */
contract Waterfall is ERC1155, Ownable, ReentrancyGuard {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    struct PriorityLevel {
        bool exists;
        uint256 totalSupply;
        uint256 maxAmount;  // 0 = uncapped (final tier), >0 = cap
        uint256 totalEarned;
        uint256 totalWithdrawn;
        uint256 cumulativeEarnedPerToken;  // Scaled by 1e18
    }

    string public projectName;
    uint256 public totalRevenue;      // Net revenue after fees
    uint256 public totalWithdrawn;
    uint256 public totalFeesCollected;

    /// @notice Payment token: address(0) = native ETH, otherwise ERC20
    address public immutable paymentToken;

    // Platform fee: skimmed on deposit, forwarded to feeRecipient
    address public immutable feeRecipient;
    uint256 public immutable feeBps;  // Basis points (500 = 5%)

    uint256[] public tierTokenIds;  // Sorted by priority
    mapping(uint256 => uint8) public tierPriorities;
    mapping(uint256 => PriorityLevel) public priorityLevels;

    // Dividend tracking: snapshot when user last withdrew
    mapping(address => mapping(uint256 => uint256)) public userLastCumulativeEarnings;
    mapping(address => mapping(uint256 => uint256)) public accruedEarnings;

    // Prevents creating multiple uncapped tiers (only the first would receive funds)
    bool private _hasUncappedTier;

    bool public finalized;

    // Events
    event PriorityCreated(uint256 indexed tokenId, uint8 priority, uint256 totalSupply, uint256 maxAmount);
    event WaterfallFinalized(uint256 tierCount);
    event RevenueDeposited(uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 totalRevenue);
    event FundsWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount);
    event DistributionCalculated(uint256 totalDistributed);
    event EarningsAccrued(address indexed user, uint256 indexed tokenId, uint256 amount);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    /// @param _projectName Display name for the project
    /// @param _uri ERC1155 metadata base URI
    /// @param _paymentToken Payment token address (address(0) for native ETH)
    /// @param _feeRecipient Address that receives platform fees (address(0) to disable fees)
    /// @param _feeBps Fee in basis points (e.g. 500 = 5%, max 1000 = 10%)
    constructor(
        string memory _projectName,
        string memory _uri,
        address _paymentToken,
        address _feeRecipient,
        uint256 _feeBps
    ) ERC1155(_uri) Ownable(msg.sender) {
        require(_feeBps <= 1000, "Fee cannot exceed 10%");
        require(_feeBps == 0 || _feeRecipient != address(0), "Fee recipient required when fee > 0");
        projectName = _projectName;
        paymentToken = _paymentToken;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    /// @notice Reject direct ETH transfers — use depositRevenue() instead
    receive() external payable {
        revert("Use depositRevenue()");
    }

    /// @notice Create a new tier in the waterfall
    /// @param tokenId Unique token ID
    /// @param priority Priority level (0 = highest, processes first)
    /// @param totalSupply Total tokens to mint
    /// @param maxAmount Revenue cap (0 = uncapped final tier)
    /// @param holders Token recipients
    /// @param amounts Tokens per recipient (must sum to totalSupply)
    function createPriority(
        uint256 tokenId,
        uint8 priority,
        uint256 totalSupply,
        uint256 maxAmount,
        address[] calldata holders,
        uint256[] calldata amounts
    ) external onlyOwner {
        require(!finalized, "Waterfall is finalized");
        require(holders.length == amounts.length, "Array length mismatch");
        require(holders.length > 0, "Must have holders");
        require(totalSupply > 0, "Total supply must be positive");
        require(!priorityLevels[tokenId].exists, "Token ID already exists");

        uint256 sum = 0;
        for (uint256 i = 0; i < holders.length; i++) {
            require(holders[i] != address(0), "Zero address not allowed");
            sum += amounts[i];
        }
        require(sum == totalSupply, "Amounts must sum to total supply");

        // Enforce unique priority values to prevent ambiguous ordering
        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            require(tierPriorities[tierTokenIds[i]] != priority, "Priority value already used");
        }

        // Only one uncapped tier allowed — a second would silently never receive funds
        if (maxAmount == 0) {
            require(!_hasUncappedTier, "Uncapped tier already exists");
            _hasUncappedTier = true;
        }

        // Create the priority level
        priorityLevels[tokenId] = PriorityLevel({
            exists: true,
            totalSupply: totalSupply,
            maxAmount: maxAmount,
            totalEarned: 0,
            totalWithdrawn: 0,
            cumulativeEarnedPerToken: 0
        });

        tierTokenIds.push(tokenId);
        tierPriorities[tokenId] = priority;
        _sortTiers();

        // Mint tokens to holders
        for (uint256 i = 0; i < holders.length; i++) {
            _mint(holders[i], tokenId, amounts[i], "");
        }

        emit PriorityCreated(tokenId, priority, totalSupply, maxAmount);
    }

    /// @notice Lock the tier structure — no new tiers can be added after this
    function finalize() external onlyOwner {
        require(!finalized, "Already finalized");
        require(_hasUncappedTier, "Must have an uncapped tier");
        finalized = true;
        emit WaterfallFinalized(tierTokenIds.length);
    }

    /// @notice Deposit revenue to be distributed through waterfall
    /// @dev For ETH: send value with call. For ERC20: approve then call with amount.
    ///      Platform fee is skimmed first; net amount enters the waterfall.
    /// @param amount Amount to deposit (only used for ERC20; ignored for ETH)
    function depositRevenue(uint256 amount) external payable {
        require(finalized, "Waterfall not finalized");
        uint256 gross;

        if (paymentToken == address(0)) {
            require(msg.value > 0, "Must deposit positive amount");
            require(amount == 0, "Do not pass amount for ETH deposits");
            gross = msg.value;
        } else {
            require(msg.value == 0, "Do not send ETH for token deposits");
            require(amount > 0, "Must deposit positive amount");
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
            gross = amount;
        }

        uint256 fee = 0;
        if (feeBps > 0) {
            fee = (gross * feeBps) / 10000;
            totalFeesCollected += fee;
            _transferOut(feeRecipient, fee);
        }

        uint256 net = gross - fee;
        totalRevenue += net;
        _calculateDistribution();
        emit RevenueDeposited(gross, fee, net, totalRevenue);
    }

    /// @notice Convenience overload for ETH deposits (no amount parameter needed)
    function depositRevenue() external payable {
        require(finalized, "Waterfall not finalized");
        require(paymentToken == address(0), "Use depositRevenue(amount) for token deposits");
        require(msg.value > 0, "Must deposit positive amount");

        uint256 fee = 0;
        if (feeBps > 0) {
            fee = (msg.value * feeBps) / 10000;
            totalFeesCollected += fee;
            _transferOut(feeRecipient, fee);
        }

        uint256 net = msg.value - fee;
        totalRevenue += net;
        _calculateDistribution();
        emit RevenueDeposited(msg.value, fee, net, totalRevenue);
    }

    /// @dev Process revenue through tiers: capped tiers cascade, uncapped consumes all
    function _calculateDistribution() internal {
        // Sum what all tiers have already been allocated
        uint256 alreadyDistributed = 0;
        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            alreadyDistributed += priorityLevels[tierTokenIds[i]].totalEarned;
        }

        uint256 undistributed = totalRevenue - alreadyDistributed;
        if (undistributed == 0) return;

        uint256 remaining = undistributed;

        // Process each tier in priority order (sorted by priority level)
        for (uint256 i = 0; i < tierTokenIds.length; i++) {
            if (remaining == 0) break;

            uint256 tokenId = tierTokenIds[i];
            remaining = _distributeTo(tokenId, remaining);

            // If uncapped tier (maxAmount = 0), it consumes all remaining
            if (priorityLevels[tokenId].maxAmount == 0) break;
        }

        emit DistributionCalculated(undistributed - remaining);
    }

    /// @dev Allocate revenue to tier (capped = up to limit, uncapped = all remaining)
    function _distributeTo(uint256 tokenId, uint256 available) internal returns (uint256) {
        PriorityLevel storage level = priorityLevels[tokenId];

        if (level.maxAmount > 0) {
            // Capped tier: distribute up to maxAmount
            uint256 alreadyEarned = level.totalEarned;
            uint256 remaining = level.maxAmount > alreadyEarned ? level.maxAmount - alreadyEarned : 0;

            if (remaining == 0) return available; // Tier fulfilled, move to next

            uint256 payment = available < remaining ? available : remaining;
            level.totalEarned += payment;
            level.cumulativeEarnedPerToken += (payment * 1e18) / level.totalSupply;

            return available - payment;
        } else {
            // Uncapped tier (final tier): consume all remaining revenue
            level.totalEarned += available;
            level.cumulativeEarnedPerToken += (available * 1e18) / level.totalSupply;

            return 0;
        }
    }

    /// @notice Withdraw your earnings for a specific token
    function withdraw(uint256 tokenId) external nonReentrant {
        uint256 balance = balanceOf(msg.sender, tokenId);
        require(balance > 0, "No tokens owned");

        uint256 available = getAvailableBalance(msg.sender, tokenId);
        require(available > 0, "No funds available");

        PriorityLevel storage level = priorityLevels[tokenId];

        // Update user's withdrawal snapshot to current cumulative earnings
        userLastCumulativeEarnings[msg.sender][tokenId] = level.cumulativeEarnedPerToken;

        // Clear accrued earnings (already included in available from getAvailableBalance)
        accruedEarnings[msg.sender][tokenId] = 0;

        // Update level totals
        level.totalWithdrawn += available;
        totalWithdrawn += available;

        _transferOut(msg.sender, available);

        emit FundsWithdrawn(msg.sender, tokenId, available);
    }

    /// @notice Withdraw earnings from multiple tokens in one transaction
    function withdrawBatch(uint256[] calldata tokenIds) external nonReentrant {
        uint256 totalAmount = 0;

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            uint256 balance = balanceOf(msg.sender, tokenId);

            if (balance > 0) {
                uint256 available = getAvailableBalance(msg.sender, tokenId);

                if (available > 0) {
                    PriorityLevel storage level = priorityLevels[tokenId];

                    // Update user's withdrawal snapshot
                    userLastCumulativeEarnings[msg.sender][tokenId] = level.cumulativeEarnedPerToken;

                    // Clear accrued earnings (already included in available from getAvailableBalance)
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

    /// @notice Get withdrawable balance for user and token (new earnings + accrued)
    function getAvailableBalance(address user, uint256 tokenId) public view returns (uint256) {
        uint256 balance = balanceOf(user, tokenId);
        if (balance == 0) return accruedEarnings[user][tokenId];

        PriorityLevel memory level = priorityLevels[tokenId];
        if (!level.exists) return 0;

        // Get user's last withdrawal snapshot
        uint256 lastSnapshot = userLastCumulativeEarnings[user][tokenId];

        // Calculate new earnings since last withdrawal/accrual
        uint256 newEarningsPerToken = level.cumulativeEarnedPerToken - lastSnapshot;
        uint256 newEarnings = (balance * newEarningsPerToken) / 1e18;

        // Add any previously accrued earnings
        newEarnings += accruedEarnings[user][tokenId];

        return newEarnings;
    }

    /// @dev Handle dividend accounting for a single token during transfer
    function _handleTransferAccounting(address from, address to, uint256 tokenId) internal {
        if (!priorityLevels[tokenId].exists) return;
        uint256 cumulativeEPT = priorityLevels[tokenId].cumulativeEarnedPerToken;
        _requireNoSenderEarnings(from, tokenId, cumulativeEPT);
        _accrueReceiverEarnings(to, tokenId, cumulativeEPT);
    }

    /// @dev Require sender has no pending earnings (new or accrued) for a token
    function _requireNoSenderEarnings(address from, uint256 tokenId, uint256 cumulativeEPT) internal view {
        uint256 senderBalance = balanceOf(from, tokenId);
        uint256 senderSnapshot = userLastCumulativeEarnings[from][tokenId];
        uint256 senderNewEarnings = (senderBalance * (cumulativeEPT - senderSnapshot)) / 1e18;
        require(senderNewEarnings == 0 && accruedEarnings[from][tokenId] == 0, "Must withdraw all earnings before transfer");
    }

    /// @dev Accrue receiver's existing earnings and update snapshot for a token
    function _accrueReceiverEarnings(address to, uint256 tokenId, uint256 cumulativeEPT) internal {
        uint256 receiverBalance = balanceOf(to, tokenId);
        if (receiverBalance > 0) {
            uint256 receiverSnapshot = userLastCumulativeEarnings[to][tokenId];
            uint256 receiverCurrentEarnings = (receiverBalance * (cumulativeEPT - receiverSnapshot)) / 1e18;
            accruedEarnings[to][tokenId] += receiverCurrentEarnings;
            emit EarningsAccrued(to, tokenId, receiverCurrentEarnings);
        }
        userLastCumulativeEarnings[to][tokenId] = cumulativeEPT;
    }

    /// @dev Transfer hook: prevent earnings from moving with tokens
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal virtual override {
        // Pre-transfer dividend protection (before balances change)
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                _handleTransferAccounting(from, to, ids[i]);
            }
        }

        super._update(from, to, ids, values);
    }

    /// @notice Get token metadata URI (on-chain JSON)
    function uri(uint256 tokenId) public view override returns (string memory) {
        PriorityLevel memory level = priorityLevels[tokenId];
        require(level.exists, "Token does not exist");

        uint256 priority = uint256(tierPriorities[tokenId]);

        string memory tierType = level.maxAmount == 0 ? "Uncapped" : "Capped";
        string memory tierDescription = level.maxAmount == 0
            ? "Uncapped tier - receives all remaining revenue"
            : "Capped tier - receives revenue up to cap";

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(string(abi.encodePacked(
                '{"name":"', projectName, ' - Priority ', priority.toString(), ' (', tierType, ')",',
                '"description":"', tierDescription, ' in ', projectName, ' waterfall at priority level ', priority.toString(), '",',
                '"attributes":[',
                    '{"trait_type":"Priority","value":', priority.toString(), '},',
                    '{"trait_type":"Tier Type","value":"', tierType, '"},',
                    '{"trait_type":"Max Amount","value":"', level.maxAmount.toString(), '"},',
                    '{"trait_type":"Total Supply","value":"', level.totalSupply.toString(), '"}',
                ']}'
            ))))
        ));
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

    /// @dev Transfer ETH or ERC20 to recipient
    function _transferOut(address to, uint256 amount) internal {
        if (paymentToken == address(0)) {
            (bool success, ) = payable(to).call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(paymentToken).safeTransfer(to, amount);
        }
    }

    function getContractBalance() external view returns (uint256) {
        if (paymentToken == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(paymentToken).balanceOf(address(this));
        }
    }

    /// @notice Rescue accidentally-sent ERC20 tokens (cannot rescue the payment token)
    /// @param token The ERC20 token to rescue
    /// @param to Recipient address
    /// @param amount Amount to rescue
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(token != paymentToken, "Cannot rescue payment token");
        require(token != address(0), "Cannot rescue ETH");
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    function getAllTiers() external view returns (uint256[] memory) {
        return tierTokenIds;
    }

    function getPriorityInfo(uint256 tokenId) external view returns (
        bool exists,
        uint256 totalSupply,
        uint256 maxAmount,
        uint256 totalEarned,
        uint256 tierWithdrawn,
        uint256 available
    ) {
        PriorityLevel memory level = priorityLevels[tokenId];
        return (
            level.exists,
            level.totalSupply,
            level.maxAmount,
            level.totalEarned,
            level.totalWithdrawn,
            level.totalEarned > level.totalWithdrawn ? level.totalEarned - level.totalWithdrawn : 0
        );
    }
}

// Base64 encoding library for metadata
library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        string memory table = TABLE;
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        string memory result = new string(encodedLen + 32);

        assembly {
            mstore(result, encodedLen)
            let tablePtr := add(table, 1)
            let dataPtr := data
            let endPtr := add(dataPtr, mload(data))
            let resultPtr := add(result, 32)

            for {} lt(dataPtr, endPtr) {}
            {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)

                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }

            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
        }

        return result;
    }
}
