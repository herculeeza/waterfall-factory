# Waterfall Smart Contracts

ERC1155-based smart contracts for transparent film revenue distribution with priority-based waterfall logic.

## 🎬 Features

- **Single-Denomination Accounting**: Each project is denominated in exactly one token — native ETH or any ERC20 (USDC, DAI, EUROC, etc.). All tier caps, deposits, and withdrawals use that single unit of account. Revenue earned in other currencies must be converted before deposit.
- **Priority-Based Distribution**: Debt positions paid in order (0 = highest) before equity
- **Platform Fee**: Configurable fee (basis points) skimmed on deposit before waterfall distribution
- **Factory Deployment**: `WaterfallFactory` deploys projects with consistent fee config and on-chain registry
- **ERC1155 Tokens**: Fungible positions within each priority level for easy trading
- **Transferable Positions**: Sell partial or full stakes in future revenue
- **Dividend Tracking**: Secure earmarking prevents double-spending on transfers
- **Token Rescue**: Owner can recover accidentally-sent tokens (but not the payment token)
- **Gas Optimized**: Batch withdrawals and efficient storage patterns

## 📋 Prerequisites

- Node.js v18+ 
- npm or yarn
- MetaMask or another Web3 wallet

## 🚀 Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd waterfall-contracts

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
nano .env
```

## 🔧 Configuration

Edit `.env` with your settings:

```bash
# Your wallet private key (NEVER commit this!)
PRIVATE_KEY=your_private_key_here

# RPC endpoints (get free ones from Alchemy or Infura)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

# Block explorer API keys for contract verification
ETHERSCAN_API_KEY=your_etherscan_key
ARBISCAN_API_KEY=your_arbiscan_key

# Platform fee configuration
FEE_RECIPIENT=0xYourCompanyWalletAddress
FEE_BPS=500  # 500 = 5%

# Optional: create a project during factory deployment
# PROJECT_NAME="My Film Project"
# PROJECT_URI="https://your-metadata-server.com/api/token/"
# PAYMENT_TOKEN=0x0000000000000000000000000000000000000000  # address(0) for ETH, or ERC20 address
```

## 🏗️ Project Structure

```
waterfall-contracts/
├── contracts/
│   ├── waterfall.sol          # Main revenue distribution contract
│   ├── WaterfallFactory.sol   # Factory for deploying projects
│   └── mocks/
│       └── MockERC20.sol      # Test token with configurable decimals
├── scripts/
│   ├── deploy.js              # Deploy the factory (+ optional first project)
│   ├── deployMockProjects.js  # Deploy both mock film projects (local)
│   ├── deployTestnet.js       # Deploy mock projects to testnet (single wallet)
│   └── mockWallets.json       # Deterministic test wallet addresses (local only)
├── test/
│   └── Waterfall.test.js
├── hardhat.config.js
└── package.json
```

## 🧪 Testing

Run the test suite:

```bash
# Run all tests
npm test

# Run tests with gas reporting
npm run test:gas

# Run specific test file
npx hardhat test test/Waterfall.test.js
```

## 📦 Compilation

```bash
npm run compile
```

This creates artifacts in `./artifacts` and type definitions in `./typechain-types`.

## 🚢 Deployment

### Mock Projects (Midnight Dreams + Urban Echoes)

The fastest way to get a fully configured local environment is to deploy the two mock film projects from the app's seed data. This gives you real contracts in a known state that mirror what the backend database describes.

**What gets deployed:**

| Project | Denomination | Status | Tiers | Revenue |
|---|---|---|---|---|
| Midnight Dreams | ETH | All debt repaid, equity distributing | P0 Reimbursements $43,450 → P1 Deferred Comp $60,550 → P2 Loans $175,000 → P3 Equity (uncapped) | $850,000 deposited |
| Urban Echoes | ETH | Halfway through Tier 2 | P0 Reimbursements $10,150 → P1 Deferred Comp $69,500 → P2 Loans $50,000 → P3 Equity (uncapped) | $42,500 deposited |

Both mock projects are denominated in ETH (`paymentToken = address(0)`). For a real deployment you could pass a stablecoin address (e.g. USDC, DAI) instead — see [Creating Projects via Factory](#-creating-projects-via-factory).

**Option A — Against a persistent local node** (recommended for interactive use):

```bash
# Terminal 1: start the node (keep it running)
npm run node

# Terminal 2: deploy both projects
npm run deploy:mock
```

**Option B — In-process Hardhat network** (quick one-shot run, no persistent state):

```bash
npm run deploy:mock:local
```

The script prints both contract addresses when it finishes. Copy them if you want to point the app at the local contracts (update `contractAddress` in the database for each project).

**Participant accounts** — The script maps Hardhat test accounts to participant roles:

```
accounts[0]   Manager / deployer

Midnight Dreams:
accounts[1]   Sarah Martinez     (Director; deferred comp + loan + equity)
accounts[2]   James Chen         (DP; deferred comp + equity)
accounts[3]   Maria Rodriguez    (Editor; deferred comp)
accounts[4]   Alice Tester       (Assoc Producer; deferred comp + equity)
accounts[5]   Coastal Catering   (reimbursement)
accounts[6]   Bay Area Cameras   (reimbursement + investor equity)
accounts[7]   Michael Davis      (reimbursement + investor equity)
accounts[8]   Lisa Anderson      (reimbursement)
accounts[9]   Indie Film Fund    (loan + investor equity)
accounts[10]  Alex Johnson       (angel investor equity)
accounts[11]  Tom Wilson         (lead actor/producer equity)

Urban Echoes:
accounts[1]   Jordan Lee         (Director/Producer; deferred comp + investor equity)
accounts[2]   Sam Patel          (Cinematographer; deferred comp + reimbursement + equity)
accounts[3]   Casey Morgan       (Editor; deferred comp + equity)
accounts[4]   Quinn Rivera       (Sound; deferred comp + reimbursement + investor equity)
accounts[5]   Alice Tester       (PA; deferred comp)
accounts[6]   Documentary Grant Fund  (loan + investor equity)
accounts[7]   City Sound Studios (reimbursement + investor equity)
```

Use these accounts with `npx hardhat console --network localhost` to call `withdraw(tokenId)` and explore the contract state interactively.

---

### Factory Deployment

The `deploy.js` script deploys the `WaterfallFactory`, which is then used to create individual project contracts. The factory enforces consistent fee configuration and maintains an on-chain registry of all projects.

```bash
# Local
npm run node                   # Terminal 1
npm run deploy:local           # Terminal 2

# Sepolia testnet
npm run deploy:sepolia

# Arbitrum Sepolia testnet
npm run deploy:arbitrum-sepolia

# Mainnet — double-check everything first!
npm run deploy:mainnet
```

The factory address is printed on completion. Save it — all projects are created through it.

To also create a first project during deployment, set `PROJECT_NAME` in `.env`.

### Sepolia Testnet

1. Get Sepolia ETH from a faucet:
   - https://sepoliafaucet.com/
   - https://www.alchemy.com/faucets/ethereum-sepolia

2. Configure `.env` with `PRIVATE_KEY`, `SEPOLIA_RPC_URL`, `FEE_RECIPIENT`, and `FEE_BPS`

3. Deploy:
```bash
npm run deploy:sepolia
```

4. Save the factory address from the output

### Arbitrum Sepolia Testnet

1. Get Arbitrum Sepolia ETH from a faucet:
   - https://www.alchemy.com/faucets/arbitrum-sepolia
   - Or bridge Sepolia ETH via the Arbitrum bridge

2. Configure `.env` with `PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, `FEE_RECIPIENT`, and `FEE_BPS`

3. Deploy:
```bash
npm run deploy:arbitrum-sepolia
```

4. Save the factory address from the output

## 🏭 Creating Projects via Factory

Once the factory is deployed, create projects through it. Each project is denominated in exactly one token — pass `address(0)` for native ETH, or an ERC20 contract address for stablecoins. The denomination is immutable and determines what currency all tier caps, deposits, and withdrawals use.

```javascript
const factory = await ethers.getContractAt("WaterfallFactory", factoryAddress);

// Create an ETH-denominated project
const tx = await factory.createProject("My Film", "https://api.example.com/metadata/", ethers.ZeroAddress);
await tx.wait();

// Or create a USDC-denominated project
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // mainnet USDC
const tx2 = await factory.createProject("My Film", "https://api.example.com/metadata/", USDC_ADDRESS);
await tx2.wait();

// Get the deployed project address
const projects = await factory.getProjectsByOwner(myAddress);
const projectAddress = projects[projects.length - 1];

// Interact with the project
const waterfall = await ethers.getContractAt("Waterfall", projectAddress);
```

### Factory Admin Functions

```javascript
// View all projects
const all = await factory.getAllProjects();
const count = await factory.projectCount();

// Update default fee for future projects (factory owner only)
await factory.setDefaultFee(newRecipient, 300); // 3%
```

## 🎯 Setting Up a Project

After creating a project (via factory or standalone), set up tiers:

```javascript
const waterfall = await ethers.getContractAt("Waterfall", projectAddress);

// Create Priority 0 — capped debt tier (investors)
await waterfall.createPriority(
  0,                            // tokenId
  0,                            // priority
  ethers.parseEther("120000"),  // totalSupply
  ethers.parseEther("120000"),  // maxAmount (cap)
  [investor1.address, investor2.address],
  [ethers.parseEther("80000"), ethers.parseEther("40000")]
);

// Create Priority 3 — uncapped equity tier (profit sharing)
await waterfall.createPriority(
  99,                // tokenId
  3,                 // priority
  1000000,           // totalSupply (shares)
  0,                 // maxAmount = 0 (uncapped)
  [manager.address, cinematographer.address],
  [400000, 600000]   // 40%, 60%
);

// Lock tiers
await waterfall.finalize();

// Deposit revenue — ETH projects:
await waterfall["depositRevenue()"]({ value: ethers.parseEther("50000") });
// → $2,500 fee to platform, $47,500 enters waterfall

// Deposit revenue — ERC20 projects (e.g. USDC):
// await usdc.approve(waterfallAddress, amount);
// await waterfall["depositRevenue(uint256)"](amount);

// Check available balance
const available = await waterfall.getAvailableBalance(investor1.address, 0);

// Withdraw
await waterfall.connect(investor1).withdraw(0);
```

## 📊 Token Structure

### Token IDs

Token IDs are arbitrary — you choose them when calling `createPriority()`. By convention the mock projects use small integers for capped tiers and `99` for the uncapped equity tier, but any unique `uint256` works.

### Token Economics

**Capped tiers (debt)**: 1 token = $1 of obligation
```
Priority 0 (Token ID 0):
- Investor A: 80,000 tokens = $80k debt
- Investor B: 40,000 tokens = $40k debt
Total: 120,000 tokens, cap: $120k
```

**Uncapped tier (equity)**: tokens represent proportional shares
```
Priority 3 (Token ID 99):
- Manager: 400,000 tokens = 40%
- Cinematographer: 350,000 tokens = 35%
- Sound Designer: 250,000 tokens = 25%
Total: 1,000,000 tokens
```

## 🔄 Waterfall Distribution

### How It Works

1. **Priority 0 Debt** gets paid first (until fully paid)
2. **Priority 1 Debt** gets paid next (until fully paid)
3. **Priority 2 Debt** gets paid next (until fully paid)
4. **Priority 3 Equity** splits ALL remaining revenue by percentage

### Example: $140k Revenue, $200k Debt

```
Priority 0: $120k debt → $120k paid ✅ (fully paid)
Priority 1: $80k debt → $20k paid ⚠️ (25% paid)
Priority 3: Equity → $0 ⚠️ (waiting for all debt)

Remaining needed: $60k to fully pay Priority 1
```

When $60k more arrives:
```
Priority 0: Already paid ✅
Priority 1: $60k paid → Now fully paid ✅
Priority 3: Any future revenue goes here
```

## 💰 Key Functions

### For Project Owners

```solidity
// Create a new tier (capped or uncapped)
createPriority(
    uint256 tokenId,       // Unique token ID
    uint8 priority,        // 0 = highest, processes first
    uint256 totalSupply,   // Total tokens to mint
    uint256 maxAmount,     // Revenue cap (0 = uncapped final tier)
    address[] holders,     // Token recipients
    uint256[] amounts      // Tokens per recipient (must sum to totalSupply)
)

// Lock the tier structure
finalize()

// Deposit revenue — ETH (fee is skimmed automatically)
depositRevenue() payable
// Deposit revenue — ERC20 (caller must approve first)
depositRevenue(uint256 amount)
// Emits: RevenueDeposited(grossAmount, fee, netAmount, totalRevenue)

// Rescue accidentally-sent ERC20 tokens (cannot rescue the payment token)
rescueTokens(address token, address to, uint256 amount)
```

### Denomination & Fee Configuration (set at deploy time)

```solidity
address public immutable paymentToken;  // address(0) = ETH, otherwise ERC20
address public immutable feeRecipient;  // Platform wallet
uint256 public immutable feeBps;        // Fee in basis points (500 = 5%, max 1000 = 10%)
uint256 public totalFeesCollected;      // Cumulative fees forwarded
```

### For Participants

```solidity
// Check available balance
getAvailableBalance(address user, uint256 tokenId) returns (uint256)

// Withdraw funds
withdraw(uint256 tokenId)

// Withdraw from multiple priorities at once
withdrawBatch(uint256[] tokenIds)

// Transfer tokens (standard ERC1155)
safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)

// Get priority details
getPriorityInfo(uint256 tokenId) returns (
    bool exists,
    uint256 totalSupply,
    uint256 maxAmount,
    uint256 totalEarned,
    uint256 tierWithdrawn,
    uint256 available
)
```

## 🔐 Security Features

### Transfer Protection
When tokens are transferred, the sender must withdraw all pending earnings first, and the receiver's snapshot is updated so they can only claim earnings from revenue deposited after the transfer:

```solidity
// Before transfer: Alice has 50k tokens, $12.5k pending
// Alice must withdraw $12.5k first
// Transfer: Alice → Bob (50k tokens)
// After transfer: Bob can only claim NEW earnings, not Alice's historical share
```

## 📈 Real-World Examples

### Example 1: Indie Film (Urban Echoes)

```javascript
// Setup
Priority 0: $120k debt (investors)
Priority 1: $80k debt (deferred crew salaries)
Priority 3: 100% equity (40% manager, 35% cinematographer, 25% sound)

// Revenue: $140k
Priority 0: $120k paid ✅
Priority 1: $20k paid (25%)
Priority 3: $0 (waiting)

// Revenue: $60k more ($200k total)
Priority 0: Fully paid ✅
Priority 1: $60k more → Fully paid ✅
Priority 3: $0 still (all revenue went to debt)

// Revenue: $100k more ($300k total)
Priority 0: Fully paid ✅
Priority 1: Fully paid ✅
Priority 3: $100k split 40/35/25 = $40k/$35k/$25k ✅
```

### Example 2: Profitable Film (Midnight Dreams)

```javascript
// Setup
Priority 0: $300k debt
Priority 1: $80k debt
Priority 2: $70k debt
Priority 3: 100% equity

// Revenue: $850k
Priority 0: $300k paid ✅
Priority 1: $80k paid ✅
Priority 2: $70k paid ✅
Priority 3: $400k remaining → split by percentage ✅

// All debt paid, equity earning!
```

## 🛠️ Advanced Usage

### Fractional Position Sales

```javascript
// Manager owns 400,000 equity tokens (40%)
// Must withdraw pending earnings first
await waterfall.connect(manager).withdraw(99);

// Then transfer half their stake
await waterfall.connect(manager).safeTransferFrom(
    manager.address,
    buyer.address,
    99,     // Token ID for equity tier
    200000, // Transfer 200k tokens (20%)
    "0x"
);

// Now: Manager has 20%, Buyer has 20%
```

### Querying Position Details

```javascript
// Get user token balance for a tier
const balance0 = await waterfall.balanceOf(user.address, 0);
const balance99 = await waterfall.balanceOf(user.address, 99);

// Get available to withdraw
const available0 = await waterfall.getAvailableBalance(user.address, 0);

// Get priority level info
const [exists, totalSupply, maxAmount, totalEarned, tierWithdrawn, available]
    = await waterfall.getPriorityInfo(0);
```

## 📊 Common Patterns

### Angel Investor + Team Split
```javascript
// Priority 0: Angel investor gets $50k back (capped)
await waterfall.createPriority(0, 0,
    ethers.parseEther("50000"), ethers.parseEther("50000"),
    [angel.address], [ethers.parseEther("50000")]);

// Priority 1: Team splits remaining 60/40 (uncapped)
await waterfall.createPriority(99, 1,
    1000000, 0,
    [founder.address, cofounder.address], [600000, 400000]);
```

### Multiple Debt Tiers + Equity
```javascript
// Priority 0: Main investors ($200k, capped)
await waterfall.createPriority(0, 0,
    ethers.parseEther("200000"), ethers.parseEther("200000"),
    [inv1.address, inv2.address],
    [ethers.parseEther("150000"), ethers.parseEther("50000")]);

// Priority 1: Deferred salaries ($100k, capped)
await waterfall.createPriority(1, 1,
    ethers.parseEther("100000"), ethers.parseEther("100000"),
    [crew1.address, crew2.address],
    [ethers.parseEther("60000"), ethers.parseEther("40000")]);

// Priority 2: Profit sharing (uncapped)
await waterfall.createPriority(99, 2,
    1000000, 0,
    [producer.address, director.address, writer.address],
    [500000, 300000, 200000]);
```

## 📱 Frontend Integration

Example using ethers.js v6:

```javascript
import { ethers } from 'ethers';
import WaterfallABI from './artifacts/contracts/Waterfall.sol/Waterfall.json';
import FactoryABI from './artifacts/contracts/WaterfallFactory.sol/WaterfallFactory.json';

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

// Connect to factory
const factory = new ethers.Contract(factoryAddress, FactoryABI.abi, signer);

// Connect to a specific project
const waterfall = new ethers.Contract(projectAddress, WaterfallABI.abi, signer);

// Check denomination
const paymentToken = await waterfall.paymentToken();
const isETH = paymentToken === ethers.ZeroAddress;

// Get user's available balance
async function getBalance(tokenId) {
    const address = await signer.getAddress();
    const balance = await waterfall.getAvailableBalance(address, tokenId);
    return ethers.formatEther(balance);
}

// Deposit revenue
async function deposit(amount) {
    if (isETH) {
        return waterfall["depositRevenue()"]({ value: amount });
    } else {
        const token = new ethers.Contract(paymentToken, ERC20ABI, signer);
        await token.approve(await waterfall.getAddress(), amount);
        return waterfall["depositRevenue(uint256)"](amount);
    }
}

// Withdraw funds
async function withdraw(tokenId) {
    const tx = await waterfall.withdraw(tokenId);
    await tx.wait();
}

// Listen for revenue deposits (includes fee breakdown)
waterfall.on("RevenueDeposited", (gross, fee, net, total) => {
    console.log(`Deposit: ${ethers.formatEther(gross)} gross, ${ethers.formatEther(fee)} fee, ${ethers.formatEther(net)} net`);
});

// Listen for withdrawals
waterfall.on("FundsWithdrawn", (user, tokenId, amount) => {
    console.log(`${user} withdrew ${ethers.formatEther(amount)} from token ${tokenId}`);
});
```

## 🧪 Testing Scenarios

The test suite covers:
- ✅ Basic deployment and initialization
- ✅ Creating debt and equity priorities
- ✅ Revenue distribution calculations
- ✅ Withdrawal mechanics
- ✅ Token transfers with snapshot updates
- ✅ Partial debt payment scenarios
- ✅ Equity distribution after debt is paid
- ✅ Batch withdrawal operations
- ✅ Protection against double-spending on transfers
- ✅ Platform fee skimming (5% on deposit)
- ✅ Net revenue distribution through waterfall after fee
- ✅ Zero-fee path (fee disabled)
- ✅ Factory project creation and ownership transfer
- ✅ Factory registry (per-owner and global)
- ✅ Fee update isolation (existing projects unaffected)
- ✅ ERC20 deposits, distribution, and withdrawals (USDC 6-decimal, DAI 18-decimal)
- ✅ ERC20 platform fee skimming
- ✅ Single-denomination enforcement (ETH waterfall rejects ERC20 and vice versa)
- ✅ Token rescue (recover wrong tokens, block rescue of payment token)
- ✅ Batch withdrawals for ERC20 projects

Run tests:
```bash
npm test
```

## 📝 Contract Verification

After deployment on testnet/mainnet:

```bash
# Verify the factory on Sepolia
npx hardhat verify --network sepolia FACTORY_ADDRESS "0xFeeRecipientAddress" 500

# Verify the factory on Arbitrum Sepolia
npx hardhat verify --network arbitrumSepolia FACTORY_ADDRESS "0xFeeRecipientAddress" 500

# Verify individual project contracts (deployed by factory)
# Args: projectName, uri, paymentToken, feeRecipient, feeBps
npx hardhat verify --network sepolia PROJECT_ADDRESS "Project Name" "https://metadata-uri.com/" "0x0000000000000000000000000000000000000000" "0xFeeRecipientAddress" 500
npx hardhat verify --network arbitrumSepolia PROJECT_ADDRESS "Project Name" "https://metadata-uri.com/" "0xUSDCAddress" "0xFeeRecipientAddress" 500
```

Or use the npm shortcuts:
```bash
npm run verify:sepolia FACTORY_ADDRESS "0xFeeRecipientAddress" 500
npm run verify:arbitrum-sepolia FACTORY_ADDRESS "0xFeeRecipientAddress" 500
```

## 🐛 Troubleshooting

### "Insufficient funds" error
- Make sure your wallet has enough ETH for gas fees
- Get testnet ETH from faucets (Sepolia)

### "Priority already exists" error
- Each priority level can only be created once
- Use different priority numbers (0, 1, 2, 3, etc.)

### "No funds available" error
- Check if revenue has been deposited: `await waterfall.totalRevenue()`
- Verify your token balance: `await waterfall.balanceOf(address, tokenId)`
- Check if funds were already withdrawn

### Transfer issues
- Make sure to use `safeTransferFrom` not `transferFrom`
- Recipient must be able to receive ERC1155 tokens
- Check token balance before transfer

## 🔒 Security Considerations

### Before Mainnet Deployment:
- [ ] Complete professional security audit
- [ ] Test extensively on testnet with real scenarios
- [ ] Verify all participant addresses are correct
- [ ] Test emergency scenarios (what if revenue never comes?)
- [ ] Consider adding pause functionality
- [ ] Review gas costs for all operations
- [ ] Test with maximum number of participants

### Operational Security:
- [ ] Use hardware wallet for owner account
- [ ] Use multi-sig for contract ownership
- [ ] Keep private keys secure (never commit to git!)
- [ ] Regularly backup deployment information
- [ ] Monitor contract for unusual activity

## 📚 Resources

- [OpenZeppelin ERC1155 Docs](https://docs.openzeppelin.com/contracts/5.x/erc1155)
- [Hardhat Documentation](https://hardhat.org/docs)
- [Ethereum Development Guides](https://ethereum.org/en/developers/docs/)
- [Sepolia Testnet Faucet](https://sepoliafaucet.com/)

## ⚠️ Disclaimer

This smart contract system handles real financial assets. Use at your own risk. Always conduct thorough testing and a professional security audit before deploying to mainnet with real funds.