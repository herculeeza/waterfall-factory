const hre = require("hardhat");
const { ethers } = require("hardhat");

/**
 * Testnet deploy script — Factory + Midnight Dreams + Urban Echoes
 *
 * Uses a single deployer wallet for everything (no multi-wallet funding needed).
 * Amounts are scaled down: $1,000,000 = 1 ETH so the whole deploy costs ~1 ETH.
 * Both projects are ETH-denominated (paymentToken = address(0)).
 *
 * Usage:
 *   npx hardhat run scripts/deployTestnet.js --network arbitrumSepolia
 *   npx hardhat run scripts/deployTestnet.js --network sepolia
 *
 * Prerequisites:
 *   - PRIVATE_KEY set in .env
 *   - Testnet ETH in the deployer wallet (~1 ETH for Arbitrum Sepolia)
 *   - ARBISCAN_API_KEY or ETHERSCAN_API_KEY in .env (for verification)
 */

// Scale: $1,000,000 = 1 ETH (small enough for testnet faucet amounts)
function e(dollars) {
  return ethers.parseEther((dollars / 1000000).toString());
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n" + "═".repeat(70));
  console.log("  WATERFALL — Testnet Deployment");
  console.log("  Factory + Midnight Dreams + Urban Echoes");
  console.log("═".repeat(70));
  console.log(`\n  Network:  ${hre.network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} ETH`);

  // All holder addresses point to deployer so we only need one funded wallet
  const D = deployer.address;

  // ── Deploy Factory ──────────────────────────────────────────────────────
  console.log("\n  🏭 Deploying WaterfallFactory (5% fee)...");
  const Factory = await ethers.getContractFactory("WaterfallFactory");
  const factory = await Factory.deploy(D, 500);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  ✅ Factory: ${factoryAddr}`);

  // ── Midnight Dreams ─────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("  🌙 MIDNIGHT DREAMS — Noir Thriller");
  console.log("     Denomination: ETH | All debt repaid, equity distributing");
  console.log("─".repeat(70));

  let tx = await factory.createProject(
    "Midnight Dreams",
    "https://api.waterfall.film/metadata/midnight-dreams/",
    ethers.ZeroAddress
  );
  await tx.wait();

  let projects = await factory.getProjectsByOwner(D);
  const mdAddr = projects[projects.length - 1];
  const md = await ethers.getContractAt("Waterfall", mdAddr);
  console.log(`  ✅ Contract: ${mdAddr}`);

  // P0 — Reimbursements ($43,450 cap, 4 holders)
  console.log("\n  📍 P0 — Reimbursements ($43,450)...");
  tx = await md.createPriority(
    0, 0, e(43450), e(43450),
    [D, D, D, D],
    [e(15750), e(24000), e(2500), e(1200)]
  );
  await tx.wait();

  // P1 — Deferred Compensation ($60,550 cap, 4 holders)
  console.log("  📍 P1 — Deferred Comp ($60,550)...");
  tx = await md.createPriority(
    1, 1, e(60550), e(60550),
    [D, D, D, D],
    [e(24000), e(15000), e(17550), e(4000)]
  );
  await tx.wait();

  // P2 — Loans ($175,000 cap, 2 holders)
  console.log("  📍 P2 — Loans ($175,000)...");
  tx = await md.createPriority(
    2, 2, e(175000), e(175000),
    [D, D],
    [e(150000), e(25000)]
  );
  await tx.wait();

  // P3 — Equity (uncapped, 10,000 tokens)
  console.log("  📍 P3 — Equity (uncapped)...");
  tx = await md.createPriority(
    99, 3, 10000, 0,
    [D, D, D, D],
    [3063, 750, 562, 5625]
  );
  await tx.wait();

  // Finalize
  tx = await md.finalize();
  await tx.wait();
  console.log("  🔒 Finalized");

  // Revenue: $850k across 5 deposits
  console.log("\n  💰 Depositing $850,000 revenue...");
  for (const [amount, desc] of [
    [180000, "Streaming rights"],
    [200000, "International distribution"],
    [200000, "Home video"],
    [150000, "VOD platforms"],
    [120000, "TV broadcast"],
  ]) {
    tx = await md["depositRevenue()"]({ value: e(amount) });
    await tx.wait();
    console.log(`     +$${amount.toLocaleString()}  (${desc})`);
  }

  // Sample withdrawal
  const mdBal = await md.getAvailableBalance(D, 2);
  if (mdBal > 0n) {
    tx = await md.withdraw(2);
    await tx.wait();
    console.log(`  💸 Withdrew ${ethers.formatEther(mdBal)} ETH from P2 (loans)`);
  }

  // ── Urban Echoes ────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("  🎵 URBAN ECHOES — Music Documentary");
  console.log("     Denomination: ETH | Tier 1 complete, halfway through Tier 2");
  console.log("─".repeat(70));

  tx = await factory.createProject(
    "Urban Echoes",
    "https://api.waterfall.film/metadata/urban-echoes/",
    ethers.ZeroAddress
  );
  await tx.wait();

  projects = await factory.getProjectsByOwner(D);
  const ueAddr = projects[projects.length - 1];
  const ue = await ethers.getContractAt("Waterfall", ueAddr);
  console.log(`  ✅ Contract: ${ueAddr}`);

  // P0 — Reimbursements ($10,150 cap, 3 holders)
  console.log("\n  📍 P0 — Reimbursements ($10,150)...");
  tx = await ue.createPriority(
    0, 0, e(10150), e(10150),
    [D, D, D],
    [e(1800), e(7500), e(850)]
  );
  await tx.wait();

  // P1 — Deferred Compensation ($69,500 cap, 5 holders)
  console.log("  📍 P1 — Deferred Comp ($69,500)...");
  tx = await ue.createPriority(
    1, 1, e(69500), e(69500),
    [D, D, D, D, D],
    [e(20000), e(18000), e(17500), e(9000), e(5000)]
  );
  await tx.wait();

  // P2 — Loans ($50,000 cap, 1 holder)
  console.log("  📍 P2 — Loans ($50,000)...");
  tx = await ue.createPriority(
    2, 2, e(50000), e(50000),
    [D],
    [e(50000)]
  );
  await tx.wait();

  // P3 — Equity (uncapped, 10,000 tokens)
  console.log("  📍 P3 — Equity (uncapped)...");
  tx = await ue.createPriority(
    99, 3, 10000, 0,
    [D, D, D, D],
    [2800, 2100, 3800, 1300]
  );
  await tx.wait();

  // Finalize
  tx = await ue.finalize();
  await tx.wait();
  console.log("  🔒 Finalized");

  // Revenue: $42,500 across 3 deposits
  console.log("\n  💰 Depositing $42,500 revenue...");
  for (const [amount, desc] of [
    [25000, "Film festival screening rights"],
    [12000, "Streaming rights"],
    [5500, "Educational distribution"],
  ]) {
    tx = await ue["depositRevenue()"]({ value: e(amount) });
    await tx.wait();
    console.log(`     +$${amount.toLocaleString()}  (${desc})`);
  }

  // Sample withdrawal from P0
  const ueBal = await ue.getAvailableBalance(D, 0);
  if (ueBal > 0n) {
    tx = await ue.withdraw(0);
    await tx.wait();
    console.log(`  💸 Withdrew ${ethers.formatEther(ueBal)} ETH from P0 (reimbursements)`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const balAfter = await ethers.provider.getBalance(D);

  console.log("\n" + "═".repeat(70));
  console.log("  🎉 DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));
  console.log("\n  Contract addresses:");
  console.log(`    Factory         : ${factoryAddr}`);
  console.log(`    Midnight Dreams : ${mdAddr}`);
  console.log(`    Urban Echoes    : ${ueAddr}`);
  console.log(`\n  Fee: 5% to deployer (${D})`);
  console.log(`  ETH spent: ~${ethers.formatEther(balance - balAfter)} ETH`);
  console.log(`  Remaining: ${ethers.formatEther(balAfter)} ETH`);

  // ── Verification ────────────────────────────────────────────────────────
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\n  ⏳ Waiting for confirmations before verification...");
    await new Promise(r => setTimeout(r, 15000));

    const contracts = [
      { name: "Factory", addr: factoryAddr, args: [D, 500] },
      { name: "Midnight Dreams", addr: mdAddr, args: ["Midnight Dreams", "https://api.waterfall.film/metadata/midnight-dreams/", ethers.ZeroAddress, D, 500] },
      { name: "Urban Echoes", addr: ueAddr, args: ["Urban Echoes", "https://api.waterfall.film/metadata/urban-echoes/", ethers.ZeroAddress, D, 500] },
    ];

    for (const c of contracts) {
      try {
        console.log(`\n  🔍 Verifying ${c.name}...`);
        await hre.run("verify:verify", { address: c.addr, constructorArguments: c.args });
        console.log(`  ✅ ${c.name} verified`);
      } catch (err) {
        if (err.message.includes("Already Verified")) {
          console.log(`  ✅ ${c.name} already verified`);
        } else {
          console.log(`  ⚠️  ${c.name} verification failed: ${err.message}`);
        }
      }
    }
  }

  console.log("\n  All holder positions assigned to deployer for testnet simplicity.");
  console.log("  In production, each holder gets their own address.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
