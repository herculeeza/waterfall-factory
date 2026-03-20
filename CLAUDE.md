# Waterfall Factory — Smart Contracts

ERC-1155 revenue distribution contracts for film projects on Arbitrum.

## Stack

- Solidity 0.8.20, Hardhat, OpenZeppelin v5
- Compiler: optimizer 200 runs, viaIR enabled
- Networks: Arbitrum Sepolia (primary testnet), Sepolia, mainnet
- Tests: Mocha + Chai via `hardhat-toolbox`

## Contracts

- `contracts/waterfall.sol` — Core revenue distribution. ERC-1155 + Ownable + ReentrancyGuard + Pausable. Dividend-per-token accounting with `PRECISION = 1e27`. Supports ETH or any ERC-20 as payment token (immutable per contract). Fee-on-transfer and rebasing tokens are not supported.
- `contracts/WaterfallFactory.sol` — CREATE2 factory with Ownable2Step. Deploys Waterfall instances, maintains on-chain registry, transfers ownership to caller.
- `contracts/mocks/MockERC20.sol` — Test token with configurable decimals.

## Commands

```
npm test              # run test suite
npm run test:gas      # with gas reporting
npm run compile       # compile contracts
```

## Key Design Decisions

- Transfer hook requires sender to withdraw before transfer; receiver snapshot is updated so they only earn from future deposits. Holder tracking is append-only (filter zero balances off-chain).
- Factory uses single-step Ownable on individual waterfalls (not Ownable2Step) so it can transfer ownership atomically during `createProject()`.
- `feeRecipient` is mutable (owner can change it). `paymentToken` and `feeBps` are immutable.
- Failed fee transfers go to `escrowedFees` rather than reverting deposits. Owner can claim via `claimEscrowedFees()`.
- Rounding dust from `(payment * PRECISION) % totalSupply` is tracked per tier to avoid cumulative precision loss.

## License

UNLICENSED — all rights reserved.
