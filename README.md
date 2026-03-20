# Waterfall Smart Contracts

ERC-1155 smart contracts for priority-based film revenue distribution on Arbitrum.

Each project is a single contract denominated in one token (ETH or any ERC-20). Revenue flows through priority tiers sequentially — capped debt tiers fill to their limit before the next tier sees anything. The final uncapped tier (equity) absorbs all remaining revenue. Within each tier, distribution is proportional to token holdings.

## Contracts

**`waterfall.sol`** (~725 lines) — The core revenue distribution contract.
- ERC-1155 + Ownable + ReentrancyGuard + Pausable (OpenZeppelin v5)
- Priority-based waterfall with dividend-per-token accounting (`PRECISION = 1e27`)
- Platform fee (basis points) skimmed on deposit, with escrow fallback if fee transfer fails
- On-chain holder enumeration via `getHolders(tokenId)` — append-only, no off-chain indexing needed
- Transfer hook enforces withdraw-before-transfer and updates receiver snapshots
- Token rescue for accidentally-sent ERC-20s (cannot rescue the payment token)

**`WaterfallFactory.sol`** (~125 lines) — Factory for deploying project contracts.
- CREATE2 deterministic deployment
- Append-only project registry with per-owner lookups
- Ownable2Step for safe ownership transfer
- Configurable default fee for new projects

## Setup

```bash
npm install
cp .env.example .env  # add PRIVATE_KEY, FEE_RECIPIENT, FEE_BPS, RPC URLs
```

## Testing

```bash
npm test                # run all tests
npm run test:gas        # with gas reporting
```

## Deployment

### Factory

```bash
npm run deploy:local              # local Hardhat node
npm run deploy:sepolia            # Sepolia testnet
npm run deploy:arbitrum-sepolia   # Arbitrum Sepolia
npm run deploy:mainnet            # mainnet
```

Set `PROJECT_NAME` in `.env` to also create a first project during deployment.

### Mock projects (local development)

Deploys the factory plus two film projects (Midnight Dreams and Urban Echoes) with tiers, token holders, and revenue deposits matching the app's seed data.

```bash
npm run node            # terminal 1
npm run deploy:mock     # terminal 2
```

| Project | Status | Tiers | Revenue |
|---|---|---|---|
| Midnight Dreams | All debt repaid, equity distributing | P0 Reimbursements $43.4k, P1 Deferred $60.5k, P2 Loans $175k, P3 Equity | $850k |
| Urban Echoes | Mid-waterfall | P0 Reimbursements $10.1k, P1 Deferred $69.5k, P2 Loans $50k, P3 Equity | $42.5k |

## Usage

### Creating a project

```javascript
const factory = await ethers.getContractAt("WaterfallFactory", factoryAddress);

// ETH-denominated project
await factory.createProject("My Film", ethers.ZeroAddress);

// USDC-denominated project
await factory.createProject("My Film", USDC_ADDRESS);
```

### Setting up tiers

```javascript
const waterfall = await ethers.getContractAt("Waterfall", projectAddress);

// Capped debt tier — 1 token = $1 of obligation
await waterfall.createPriority(
  0,                            // tokenId
  0,                            // priority (0 = highest)
  ethers.parseEther("120000"),  // totalSupply
  ethers.parseEther("120000"),  // maxAmount (cap)
  [investor1.address, investor2.address],
  [ethers.parseEther("80000"), ethers.parseEther("40000")]
);

// Uncapped equity tier — tokens represent proportional shares
await waterfall.createPriority(
  99,              // tokenId
  3,               // priority
  1000000,         // totalSupply (shares)
  0,               // maxAmount = 0 means uncapped
  [producer.address, director.address],
  [600000, 400000] // 60%, 40%
);

await waterfall.finalize(); // lock tier structure
```

### Revenue and withdrawals

```javascript
// Deposit (ETH)
await waterfall["depositRevenue()"]({ value: ethers.parseEther("50000") });

// Deposit (ERC-20 — caller must approve first)
await waterfall["depositRevenue(uint256)"](amount);

// Check and withdraw
const available = await waterfall.getAvailableBalance(user.address, tokenId);
await waterfall.connect(user).withdraw(tokenId);
await waterfall.connect(user).withdrawBatch([0, 1, 99]); // multiple tiers
```

### Transfers

Tokens are standard ERC-1155 `safeTransferFrom`. The transfer hook requires the sender to withdraw pending earnings first, and updates the receiver's snapshot so they only earn from future deposits.

```javascript
// Sell half a 40% equity stake
await waterfall.connect(manager).withdraw(99); // must withdraw first
await waterfall.connect(manager).safeTransferFrom(
    manager.address, buyer.address, 99, 200000, "0x"
);
```

### Admin

```javascript
await waterfall.pause();                          // emergency stop
await waterfall.unpause();
await waterfall.setFeeRecipient(newAddress);      // change fee recipient
await waterfall.claimEscrowedFees();              // claim failed fee transfers
await waterfall.rescueTokens(token, to, amount);  // recover wrong tokens
await waterfall.rescueETH(to);                    // recover force-sent ETH
```

## Waterfall example

```
Revenue: $140k into a project with $200k total debt

Priority 0: $120k cap  →  $120k paid (full)
Priority 1: $80k cap   →  $20k paid (25%)
Priority 3: equity     →  $0 (waiting for debt)

Another $160k arrives ($300k total):

Priority 0: already full
Priority 1: $60k more  →  $80k paid (full)
Priority 3: equity     →  $100k split by token holdings
```

## Contract verification

```bash
# Factory
npx hardhat verify --network arbitrumSepolia FACTORY_ADDRESS "FEE_RECIPIENT" FEE_BPS

# Individual project (deployed by factory)
npx hardhat verify --network arbitrumSepolia PROJECT_ADDRESS "Project Name" "PAYMENT_TOKEN" "FEE_RECIPIENT" FEE_BPS
```

## Deployments

See [DEPLOYMENTS.md](./DEPLOYMENTS.md) for deployed contract addresses.

## License

UNLICENSED — All rights reserved.
