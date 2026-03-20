// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./waterfall.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title WaterfallFactory - Deploys and registers Waterfall project contracts
 * @dev Single deployment point for all waterfall projects. Enforces consistent
 *      fee configuration and maintains an on-chain registry of all projects.
 *      Uses CREATE2 for deterministic project addresses.
 *
 * NOTE: Project registry is append-only — there is no deregister function.
 *       Projects created in error remain in the registry but have no impact
 *       on other projects. Filter inactive projects off-chain.
 *
 * NOTE: Uses Ownable2Step for factory ownership to prevent accidental transfer.
 *       Waterfall contracts use single-step Ownable since the factory must
 *       transfer ownership atomically during createProject.
 */
contract WaterfallFactory is Ownable2Step {

    error FeeExceedsMax();
    error FeeRecipientRequired();
    error ETHTransferFailed();

    // Default fee settings applied to new projects
    address public defaultFeeRecipient;
    uint256 public defaultFeeBps;

    // Registry
    address[] public allProjects;
    mapping(address => address[]) public projectsByOwner;

    event ProjectCreated(
        address indexed projectAddress,
        address indexed projectOwner,
        string projectName,
        address feeRecipient,
        uint256 feeBps
    );
    event DefaultFeeUpdated(address feeRecipient, uint256 feeBps);
    event ETHRescued(address indexed to, uint256 amount);

    /// @param _feeRecipient Address that receives platform fees
    /// @param _feeBps Default fee in basis points (e.g. 500 = 5%)
    constructor(
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        if (_feeBps > 1000) revert FeeExceedsMax();
        if (_feeBps > 0 && _feeRecipient == address(0)) revert FeeRecipientRequired();
        defaultFeeRecipient = _feeRecipient;
        defaultFeeBps = _feeBps;
    }

    /// @notice Deploy a new Waterfall project using the default fee settings
    /// @param projectName Display name for the project
    /// @param _paymentToken Payment token address (address(0) for native ETH)
    /// @return projectAddress Address of the newly deployed Waterfall contract
    function createProject(
        string calldata projectName,
        address _paymentToken
    ) external returns (address projectAddress) {
        bytes32 salt = keccak256(abi.encode(msg.sender, allProjects.length));

        Waterfall project = new Waterfall{salt: salt}(
            projectName,
            _paymentToken,
            defaultFeeRecipient,
            defaultFeeBps
        );

        // Transfer ownership to the caller so they can set up tiers
        project.transferOwnership(msg.sender);

        projectAddress = address(project);
        allProjects.push(projectAddress);
        projectsByOwner[msg.sender].push(projectAddress);

        emit ProjectCreated(projectAddress, msg.sender, projectName, defaultFeeRecipient, defaultFeeBps);
    }

    /// @notice Update the default fee for future projects (does not affect existing ones)
    /// @param _feeRecipient New fee recipient address
    /// @param _feeBps New fee in basis points
    function setDefaultFee(address _feeRecipient, uint256 _feeBps) external onlyOwner {
        if (_feeBps > 1000) revert FeeExceedsMax();
        if (_feeBps > 0 && _feeRecipient == address(0)) revert FeeRecipientRequired();
        defaultFeeRecipient = _feeRecipient;
        defaultFeeBps = _feeBps;
        emit DefaultFeeUpdated(_feeRecipient, _feeBps);
    }

    // --- View Functions ---

    /// @notice Get total number of projects deployed through this factory
    function projectCount() external view returns (uint256) {
        return allProjects.length;
    }

    /// @notice Get all projects deployed by a specific owner
    /// @param projectOwner Address of the project owner
    /// @return Array of project contract addresses
    function getProjectsByOwner(address projectOwner) external view returns (address[] memory) {
        return projectsByOwner[projectOwner];
    }

    /// @notice Get all projects deployed through this factory
    /// @return Array of all project contract addresses
    function getAllProjects() external view returns (address[] memory) {
        return allProjects;
    }

    // --- Rescue Functions ---

    /// @notice Rescue accidentally force-sent ETH (factory should never hold ETH)
    /// @param to Recipient address
    function rescueETH(address to) external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = payable(to).call{value: balance}("");
        if (!success) revert ETHTransferFailed();
        emit ETHRescued(to, balance);
    }
}
