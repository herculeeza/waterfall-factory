// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./waterfall.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title WaterfallFactory - Deploys and registers Waterfall project contracts
 * @dev Single deployment point for all waterfall projects. Enforces consistent
 *      fee configuration and maintains an on-chain registry of all projects.
 */
contract WaterfallFactory is Ownable {

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

    /// @param _feeRecipient Address that receives platform fees
    /// @param _feeBps Default fee in basis points (e.g. 500 = 5%)
    constructor(
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_feeBps <= 1000, "Fee cannot exceed 10%");
        require(_feeBps == 0 || _feeRecipient != address(0), "Fee recipient required when fee > 0");
        defaultFeeRecipient = _feeRecipient;
        defaultFeeBps = _feeBps;
    }

    /// @notice Deploy a new Waterfall project using the default fee settings
    /// @param projectName Display name for the project
    /// @param uri ERC1155 metadata base URI
    /// @param _paymentToken Payment token address (address(0) for native ETH)
    /// @return projectAddress Address of the newly deployed Waterfall contract
    function createProject(
        string calldata projectName,
        string calldata uri,
        address _paymentToken
    ) external returns (address projectAddress) {
        Waterfall project = new Waterfall(
            projectName,
            uri,
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
        require(_feeBps <= 1000, "Fee cannot exceed 10%");
        require(_feeBps == 0 || _feeRecipient != address(0), "Fee recipient required when fee > 0");
        defaultFeeRecipient = _feeRecipient;
        defaultFeeBps = _feeBps;
        emit DefaultFeeUpdated(_feeRecipient, _feeBps);
    }

    /// @notice Get total number of projects deployed through this factory
    function projectCount() external view returns (uint256) {
        return allProjects.length;
    }

    /// @notice Get all projects deployed by a specific owner
    function getProjectsByOwner(address owner) external view returns (address[] memory) {
        return projectsByOwner[owner];
    }

    /// @notice Get all projects deployed through this factory
    function getAllProjects() external view returns (address[] memory) {
        return allProjects;
    }
}
