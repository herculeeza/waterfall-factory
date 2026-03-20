# Project Structure

Complete file structure for the Waterfall smart contracts project.

## Directory Structure

```
waterfall-factory/
├── contracts/
│   ├── waterfall.sol          # Main revenue distribution contract
│   ├── WaterfallFactory.sol   # Factory for deploying projects
│   └── mocks/
│       └── MockERC20.sol      # Test token with configurable decimals
│
├── scripts/
│   ├── deploy.js              # Deploy factory (+ optional first project)
│   ├── deployMockProjects.js  # Deploy both mock film projects (local node)
│   ├── deployTestnet.js       # Deploy mock projects to testnet (single wallet)
│   └── mockWallets.json       # Deterministic test wallet addresses (local only)
│
├── test/
│   └── Waterfall.test.js      # Comprehensive test suite
│
├── artifacts/                 # Compiled contracts (generated)
├── cache/                     # Hardhat cache (generated)
├── node_modules/              # Dependencies (generated)
│
├── .env                       # Environment variables (create from .env.example)
├── .env.example               # Environment template
├── .gitignore                 # Git ignore rules
├── hardhat.config.js          # Hardhat configuration
├── package.json               # NPM dependencies and scripts
├── README.md                  # Full documentation
└── PROJECT-STRUCTURE.md       # This file
```

## File Descriptions

### Contracts

**`contracts/waterfall.sol`**
- Main smart contract implementing ERC1155-based revenue distribution
- Each contract is denominated in a single token (ETH or ERC20) — set at deploy time via `paymentToken`
- Features: Priority-based waterfall, platform fee, dividend tracking, transferable positions, on-chain holder enumeration, token rescue
- Dependencies: OpenZeppelin contracts (ERC1155, IERC20, SafeERC20, Ownable, ReentrancyGuard)

**`contracts/WaterfallFactory.sol`**
- Factory contract for deploying Waterfall project instances
- Callers specify the payment token (denomination) when creating a project
- Features: On-chain project registry, configurable default fee, ownership transfer to caller
- Dependencies: waterfall.sol, OpenZeppelin Ownable

**`contracts/mocks/MockERC20.sol`**
- Simple ERC20 token with configurable decimals for testing
- Used in tests to verify USDC (6 decimals) and DAI (18 decimals) support

### Scripts

**`scripts/deploy.js`**
- Deploys WaterfallFactory (+ optional first project via `PROJECT_NAME` env var)
- Works with: local, Sepolia, Arbitrum Sepolia, mainnet
- Reads: `FEE_RECIPIENT`, `FEE_BPS` from environment
- Auto-verifies on Etherscan/Arbiscan if API key provided

**`scripts/deployMockProjects.js`**
- Deploys factory + Midnight Dreams + Urban Echoes on a local Hardhat node
- Uses multi-wallet setup from `mockWallets.json` to match backend seed data
- Simulates revenue deposits and sample withdrawals
- Amounts scaled: $1,000 = 1 ETH

**`scripts/deployTestnet.js`**
- Deploys factory + Midnight Dreams + Urban Echoes on a public testnet
- Uses a single deployer wallet (all holder positions assigned to deployer)
- Includes contract verification via Etherscan/Arbiscan
- Amounts scaled: $1,000 = 1 ETH

### Tests

**`test/Waterfall.test.js`**
- 40 tests covering: deployment, priorities, distribution, withdrawals, transfers, platform fees, factory, ERC20 support, token rescue
- Framework: Mocha + Chai + Hardhat
- Run: `npm test`

### Configuration

**`hardhat.config.js`**
- Networks: hardhat (local), Sepolia, Arbitrum Sepolia, mainnet
- Solidity 0.8.20, optimizer enabled (200 runs), viaIR
- Etherscan/Arbiscan verification configuration

**`package.json`**
- Dependencies: Hardhat, OpenZeppelin v5, dotenv
- Scripts: compile, test, deploy (local/sepolia/arbitrum/mainnet), verify

**`.env.example`**
- Template for environment variables
- Required for deployment: PRIVATE_KEY, FEE_RECIPIENT, FEE_BPS
- Optional: RPC URLs, Etherscan/Arbiscan API keys, PROJECT_NAME
