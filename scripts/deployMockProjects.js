const hre = require("hardhat");
const { ethers } = require("hardhat");
const WALLETS = require("./mockWallets.json");

/**
 * Deploy script for the 2 'launched' mock film projects:
 *   1. Midnight Dreams  - Noir thriller; all debt repaid, equity distributing
 *   2. Urban Echoes     - Music documentary; halfway through Tier 2 (deferred comp)
 *
 * Both mock projects are denominated in ETH (paymentToken = address(0)).
 * Each waterfall contract is denominated in exactly one token — all deposits,
 * tier caps, and withdrawals use that single unit. For a real deployment you
 * could pass a stablecoin address (USDC, DAI, etc.) instead.
 *
 * Deploys a WaterfallFactory first (5% fee to the Hardhat funder), then creates
 * both projects through the factory. Uses the same wallet addresses as the
 * backend seed data (mockWallets.json), so on-chain state matches the app DB.
 *
 * Usage:
 *   # Start a local node in one terminal:
 *   npx hardhat node
 *
 *   # Run this script in another:
 *   npx hardhat run scripts/deployMockProjects.js --network localhost
 *
 * Or for a quick one-shot run (no persistent node):
 *   npx hardhat run scripts/deployMockProjects.js --network hardhat
 */

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function e(dollars) {
  // Scale: $1,000 = 1 ETH so all amounts fit on the local Hardhat node
  return ethers.parseEther((dollars / 1000).toString());
}

/** Load a wallet from mockWallets.json and connect it to the Hardhat provider */
function wallet(key) {
  return new ethers.Wallet(WALLETS[key].privateKey, ethers.provider);
}

function addr(key) {
  return WALLETS[key].address;
}

/** Fund a list of wallet keys from a funder account (covers gas + any ETH needed) */
async function fundWallets(funder, keys, etherEach = "10") {
  for (const key of keys) {
    const tx = await funder.sendTransaction({
      to: WALLETS[key].address,
      value: ethers.parseEther(etherEach),
    });
    await tx.wait();
  }
}

async function printState(waterfall, label) {
  const totalRevenue = await waterfall.totalRevenue();
  const totalWithdrawn = await waterfall.totalWithdrawn();
  const contractBalance = await ethers.provider.getBalance(await waterfall.getAddress());
  const tiers = await waterfall.getAllTiers();

  console.log(`\n  📊 ${label}`);
  console.log(`     Total revenue deposited : $${ethers.formatEther(totalRevenue)}`);
  console.log(`     Total withdrawn          : $${ethers.formatEther(totalWithdrawn)}`);
  console.log(`     Contract ETH balance     : $${ethers.formatEther(contractBalance)}`);

  for (const tokenId of tiers) {
    const info = await waterfall.getPriorityInfo(tokenId);
    const tierType = info.maxAmount === 0n ? "Equity (uncapped)" : "Debt (capped)";
    const cap = info.maxAmount === 0n ? "∞" : `$${ethers.formatEther(info.maxAmount)}`;
    console.log(
      `     Token ${String(tokenId).padEnd(3)} [${tierType}] ` +
      `cap=${cap}  earned=$${ethers.formatEther(info.totalEarned)}  ` +
      `withdrawn=$${ethers.formatEther(info.tierWithdrawn)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT 1: MIDNIGHT DREAMS
// ─────────────────────────────────────────────────────────────────────────────

async function deployMidnightDreams(factory, funder) {
  console.log("\n" + "═".repeat(70));
  console.log("  🌙  MIDNIGHT DREAMS  — Noir Thriller");
  console.log("      Denomination: ETH | Status: All debt repaid | Equity distributing");
  console.log("═".repeat(70));

  // Fund the participant wallets that need to sign transactions
  console.log("\n  💳 Funding participant wallets from Hardhat funder...");
  // Manager needs ~850 ETH to cover scaled revenue deposits; others just need gas
  await fundWallets(funder, ["manager"], "1000");
  await fundWallets(funder, [
    "sarah_martinez", "james_chen", "maria_rodriguez", "alice",
    "coastal_catering", "bay_area_cameras", "michael_davis", "lisa_anderson",
    "indie_film_fund", "alex_johnson", "tom_wilson",
  ], "1");
  console.log("  ✅ Wallets funded");

  const deployer = wallet("manager");

  // ── Create project via factory ──────────────────────────────────────────────
  console.log("\n  📄 Creating project via factory...");
  let tx = await factory.connect(deployer).createProject(
    "Midnight Dreams",
    ethers.ZeroAddress // ETH payment
  );
  await tx.wait();

  const projects = await factory.getProjectsByOwner(deployer.address);
  const contractAddr = projects[projects.length - 1];
  const waterfall = await ethers.getContractAt("Waterfall", contractAddr, deployer);

  console.log(`  ✅ Contract deployed to: ${contractAddr}`);
  console.log(`     Owner (manager):      ${addr("manager")}`);

  // ── Priority 0 — Reimbursements ($43,450 total) ───────────────────────────
  // Source: mdReimbursements in seed.js
  //   Coastal Catering:  35 × $450  = $15,750
  //   Bay Area Cameras:  30 × $800  = $24,000
  //   Michael Davis:      1 × $2,500 =  $2,500
  //   Lisa Anderson:      1 × $1,200 =  $1,200
  console.log("\n  📍 Creating Priority 0 — Reimbursements ($43,450)...");
  tx = await waterfall.createPriority(
    0, 0, e(43450), e(43450),
    [addr("coastal_catering"), addr("bay_area_cameras"), addr("michael_davis"), addr("lisa_anderson")],
    [e(15750),                  e(24000),                e(2500),               e(1200)]
  );
  await tx.wait();
  console.log("  ✅ P0: Coastal Catering $15,750 | Bay Area Cameras $24,000 | Michael Davis $2,500 | Lisa Anderson $1,200");

  // ── Priority 1 — Deferred Compensation ($60,550 total) ────────────────────
  // Source: mdProductionDays in seed.js
  //   Sarah Martinez:    30 days × $800/day                    = $24,000
  //   James Chen:        25 days × $600/day                    = $15,000
  //   Maria Rodriguez:   30 days × $500/day + 34 hrs × $75/hr  = $17,550
  //   Alice Tester:      10 days × $400/day                    =  $4,000
  console.log("\n  📍 Creating Priority 1 — Deferred Compensation ($60,550)...");
  tx = await waterfall.createPriority(
    1, 1, e(60550), e(60550),
    [addr("sarah_martinez"), addr("james_chen"), addr("maria_rodriguez"), addr("alice")],
    [e(24000),               e(15000),           e(17550),                e(4000)]
  );
  await tx.wait();
  console.log("  ✅ P1: Sarah $24,000 | James $15,000 | Maria $17,550 | Alice $4,000");

  // ── Priority 2 — Loans ($175,000 total) ───────────────────────────────────
  // Source: mdLoans in seed.js
  //   Indie Film Fund LLC:  $150,000 at 5% interest
  //   Sarah Martinez:        $25,000 at 0% interest
  console.log("\n  📍 Creating Priority 2 — Loans ($175,000)...");
  tx = await waterfall.createPriority(
    2, 2, e(175000), e(175000),
    [addr("indie_film_fund"), addr("sarah_martinez")],
    [e(150000),               e(25000)]
  );
  await tx.wait();
  console.log("  ✅ P2: Indie Film Fund $150,000 | Sarah Martinez $25,000");

  // ── Priority 3 — Equity (uncapped) ────────────────────────────────────────
  // Source: mdProducerShares + mdInvestorShares in seed.js
  // 10,000 total tokens split 30% producers / 70% investors:
  //
  //   Producers (3,000 tokens from 800 total shares):
  //     Sarah Martinez:    350/800 × 3,000 = 1,313
  //     James Chen:        200/800 × 3,000 =   750
  //     Tom Wilson:        150/800 × 3,000 =   562
  //     Alice Tester:      100/800 × 3,000 =   375
  //
  //   Investors (7,000 tokens from $300,000 total invested):
  //     Indie Film Fund:   150k/300k × 7,000 = 3,500
  //     Alex Johnson:       75k/300k × 7,000 = 1,750
  //     Michael Davis:      50k/300k × 7,000 = 1,167
  //     Bay Area Cameras:   25k/300k × 7,000 =   583
  console.log("\n  📍 Creating Priority 3 — Equity (uncapped, 10,000 tokens)...");
  tx = await waterfall.createPriority(
    99, 3, 10000, 0,
    [
      addr("sarah_martinez"), addr("james_chen"), addr("tom_wilson"), addr("alice"),
      addr("indie_film_fund"), addr("alex_johnson"), addr("michael_davis"), addr("bay_area_cameras")
    ],
    [1313, 750, 562, 375, 3500, 1750, 1167, 583]
  );
  await tx.wait();
  console.log("  ✅ P3 (equity): 10,000 tokens across 8 holders");

  // ── Finalize ───────────────────────────────────────────────────────────────
  tx = await waterfall.finalize();
  await tx.wait();
  console.log("\n  🔒 Waterfall finalized");

  // ── Revenue deposits ───────────────────────────────────────────────────────
  // Source: revenue transactions in seed.js
  console.log("\n  💰 Depositing $850,000 revenue across 5 tranches...");
  for (const [amount, desc] of [
    [180000, "Streaming rights - Netflix"],
    [200000, "International distribution rights"],
    [200000, "Home video and physical media"],
    [150000, "VOD and streaming platforms"],
    [120000, "Television broadcast rights"],
  ]) {
    tx = await waterfall["depositRevenue()"]({ value: e(amount) });
    await tx.wait();
    console.log(`  ✅ +$${amount.toLocaleString()}  (${desc})`);
  }

  await printState(waterfall, "State after all revenue deposited");
  console.log("\n  💡 All $279,000 debt fully covered. $571,000 distributable as equity.");

  // ── Sample withdrawals ─────────────────────────────────────────────────────
  console.log("\n  💸 Simulating withdrawals...");

  for (const [key, tokenId, label] of [
    ["indie_film_fund",  2,  "Indie Film Fund (loan repayment)"],
    ["sarah_martinez",   2,  "Sarah Martinez (loan repayment)"],
    ["sarah_martinez",   99, "Sarah Martinez (equity)"],
    ["james_chen",       99, "James Chen (equity)"],
  ]) {
    const w = wallet(key);
    const bal = await waterfall.getAvailableBalance(w.address, tokenId);
    if (bal > 0n) {
      tx = await waterfall.connect(w).withdraw(tokenId);
      await tx.wait();
      console.log(`  ✅ ${label}: withdrew $${ethers.formatEther(bal)}`);
    }
  }

  await printState(waterfall, "Final state after sample withdrawals");
  return contractAddr;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT 2: URBAN ECHOES
// ─────────────────────────────────────────────────────────────────────────────

async function deployUrbanEchoes(factory, funder) {
  console.log("\n" + "═".repeat(70));
  console.log("  🎵  URBAN ECHOES  — Music Documentary");
  console.log("      Denomination: ETH | Status: Tier 1 complete | Halfway through Tier 2");
  console.log("═".repeat(70));

  console.log("\n  💳 Funding participant wallets from Hardhat funder...");
  // manager and alice already funded during Midnight Dreams deployment
  await fundWallets(funder, [
    "jordan_lee", "sam_patel", "casey_morgan", "quinn_rivera",
    "doc_grant_fund", "city_sound_studios",
  ], "1");
  console.log("  ✅ Wallets funded");

  const deployer = wallet("manager");

  // ── Create project via factory ──────────────────────────────────────────────
  console.log("\n  📄 Creating project via factory...");
  let tx = await factory.connect(deployer).createProject(
    "Urban Echoes",
    ethers.ZeroAddress // ETH payment
  );
  await tx.wait();

  const projects = await factory.getProjectsByOwner(deployer.address);
  const contractAddr = projects[projects.length - 1];
  const waterfall = await ethers.getContractAt("Waterfall", contractAddr, deployer);

  console.log(`  ✅ Contract deployed to: ${contractAddr}`);
  console.log(`     Owner (manager):      ${addr("manager")}`);

  // ── Priority 0 — Reimbursements ($10,150 total) ───────────────────────────
  // Source: ueReimbursements in seed.js
  //   Sam Patel:          1 × $1,800 = $1,800  (drone rental)
  //   City Sound Studios: 15 × $500  = $7,500  (audio post-production suite)
  //   Quinn Rivera:        1 × $850  =   $850  (professional microphone)
  console.log("\n  📍 Creating Priority 0 — Reimbursements ($10,150)...");
  tx = await waterfall.createPriority(
    0, 0, e(10150), e(10150),
    [addr("sam_patel"),  addr("city_sound_studios"), addr("quinn_rivera")],
    [e(1800),            e(7500),                    e(850)]
  );
  await tx.wait();
  console.log("  ✅ P0: Sam Patel $1,800 | City Sound Studios $7,500 | Quinn Rivera $850");

  // ── Priority 1 — Deferred Compensation ($69,500 total) ────────────────────
  // Source: ueProductionDays in seed.js
  //   Jordan Lee:    40 days × $500/day = $20,000
  //   Sam Patel:     45 days × $400/day = $18,000
  //   Casey Morgan:  50 days × $350/day = $17,500
  //   Quinn Rivera:  30 days × $300/day =  $9,000
  //   Alice Tester:  20 days × $250/day =  $5,000
  console.log("\n  📍 Creating Priority 1 — Deferred Compensation ($69,500)...");
  tx = await waterfall.createPriority(
    1, 1, e(69500), e(69500),
    [addr("jordan_lee"), addr("sam_patel"), addr("casey_morgan"), addr("quinn_rivera"), addr("alice")],
    [e(20000),           e(18000),          e(17500),             e(9000),              e(5000)]
  );
  await tx.wait();
  console.log("  ✅ P1: Jordan $20,000 | Sam $18,000 | Casey $17,500 | Quinn $9,000 | Alice $5,000");

  // ── Priority 2 — Loans ($50,000 total) ────────────────────────────────────
  // Source: ueLoans in seed.js
  //   Documentary Grant Fund: $50,000 at 0% interest (repayable grant)
  console.log("\n  📍 Creating Priority 2 — Loans ($50,000)...");
  tx = await waterfall.createPriority(
    2, 2, e(50000), e(50000),
    [addr("doc_grant_fund")],
    [e(50000)]
  );
  await tx.wait();
  console.log("  ✅ P2: Documentary Grant Fund $50,000");

  // ── Priority 3 — Equity (uncapped) ────────────────────────────────────────
  // Source: ueProducerShares + ueInvestorShares in seed.js
  // 10,000 total tokens split 30% producers / 70% investors:
  //
  //   Producers (3,000 tokens from 1,000 total shares):
  //     Jordan Lee:    400/1,000 × 3,000 = 1,200
  //     Sam Patel:     300/1,000 × 3,000 =   900
  //     Casey Morgan:  300/1,000 × 3,000 =   900
  //
  //   Investors (7,000 tokens from $500,000 total invested):
  //     Documentary Grant Fund: 200k/500k × 7,000 = 2,800
  //     City Sound Studios:     150k/500k × 7,000 = 2,100
  //     Quinn Rivera:           100k/500k × 7,000 = 1,400
  //     Jordan Lee:              50k/500k × 7,000 =   700  ← also a producer
  //
  //   Combined (Jordan Lee: 1,200 + 700 = 1,900):
  //     Jordan Lee: 1,900 | Sam Patel: 900 | Casey Morgan: 900
  //     Doc Grant Fund: 2,800 | City Sound: 2,100 | Quinn Rivera: 1,400
  console.log("\n  📍 Creating Priority 3 — Equity (uncapped, 10,000 tokens)...");
  tx = await waterfall.createPriority(
    99, 3, 10000, 0,
    [
      addr("jordan_lee"), addr("sam_patel"), addr("casey_morgan"),
      addr("doc_grant_fund"), addr("city_sound_studios"), addr("quinn_rivera")
    ],
    [1900, 900, 900, 2800, 2100, 1400]
  );
  await tx.wait();
  console.log("  ✅ P3 (equity): 10,000 tokens across 6 holders");

  // ── Finalize ───────────────────────────────────────────────────────────────
  tx = await waterfall.finalize();
  await tx.wait();
  console.log("\n  🔒 Waterfall finalized");

  // ── Revenue deposits ───────────────────────────────────────────────────────
  // Source: revenue transactions in seed.js
  console.log("\n  💰 Depositing $42,500 revenue across 3 tranches...");
  for (const [amount, desc] of [
    [25000, "Film festival screening rights and awards"],
    [12000, "Streaming rights - documentary platform"],
    [5500,  "Educational distribution rights"],
  ]) {
    tx = await waterfall["depositRevenue()"]({ value: e(amount) });
    await tx.wait();
    console.log(`  ✅ +$${amount.toLocaleString()}  (${desc})`);
  }

  await printState(waterfall, "State after all revenue deposited");
  console.log("\n  💡 Waterfall progress:");
  console.log("     Tier 0 (Reimbursements $10,150) .... ✅ COMPLETE");
  console.log("     Tier 1 (Deferred Comp $69,500) ..... ⭐ HALFWAY ($32,350 / $69,500)");
  console.log("     Tier 2 (Loans $50,000) ............. ⏳ NOT YET REACHED");
  console.log("     Tier 3 (Equity) ..................... ⏳ NOT YET REACHED");

  // ── Tier 0 withdrawals ─────────────────────────────────────────────────────
  console.log("\n  💸 Simulating Tier 0 withdrawals (reimbursements fully claimable)...");
  for (const key of ["sam_patel", "city_sound_studios", "quinn_rivera"]) {
    const w = wallet(key);
    const bal = await waterfall.getAvailableBalance(w.address, 0);
    if (bal > 0n) {
      tx = await waterfall.connect(w).withdraw(0);
      await tx.wait();
      console.log(`  ✅ ${key}: withdrew $${ethers.formatEther(bal)} (reimbursement)`);
    }
  }

  // ── Partial Tier 1 withdrawals ─────────────────────────────────────────────
  console.log("\n  💸 Simulating partial Tier 1 withdrawals (deferred comp)...");
  for (const key of ["jordan_lee", "sam_patel"]) {
    const w = wallet(key);
    const bal = await waterfall.getAvailableBalance(w.address, 1);
    if (bal > 0n) {
      tx = await waterfall.connect(w).withdraw(1);
      await tx.wait();
      console.log(`  ✅ ${key}: withdrew $${ethers.formatEther(bal)} (deferred comp)`);
    }
  }
  console.log("  ⚠️  Casey Morgan, Quinn Rivera, Alice Tester have unclaimed deferred comp.");

  await printState(waterfall, "Final state after sample withdrawals");
  return contractAddr;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("  WATERFALL — Mock Project Deployment");
  console.log("  Factory + Midnight Dreams + Urban Echoes");
  console.log("═".repeat(70) + "\n");

  // Use the first Hardhat default account as the funder (it has 10,000 ETH)
  const [funder] = await ethers.getSigners();
  console.log(`  Hardhat funder: ${funder.address}`);
  console.log(`  Network:        ${hre.network.name}`);
  const balance = await ethers.provider.getBalance(funder.address);
  console.log(`  Funder balance: ${ethers.formatEther(balance)} ETH`);

  // ── Deploy factory ──────────────────────────────────────────────────────────
  console.log("\n  🏭 Deploying WaterfallFactory (5% fee to funder)...");
  const FactoryContract = await ethers.getContractFactory("WaterfallFactory");
  const factory = await FactoryContract.deploy(funder.address, 500);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`  ✅ Factory deployed to: ${factoryAddress}`);

  // ── Deploy projects via factory ─────────────────────────────────────────────
  const mdAddress = await deployMidnightDreams(factory, funder);
  const ueAddress = await deployUrbanEchoes(factory, funder);

  console.log("\n" + "═".repeat(70));
  console.log("  🎉  DEPLOYMENT COMPLETE");
  console.log("═".repeat(70));
  console.log("\n  Contract addresses:");
  console.log(`    Factory         : ${factoryAddress}`);
  console.log(`    Midnight Dreams : ${mdAddress}`);
  console.log(`    Urban Echoes    : ${ueAddress}`);
  console.log(`\n  Fee: 5% to ${funder.address}`);
  console.log("\n  Wallet addresses match the backend seed data (mockWallets.json).");
  console.log("  Update contractAddress in the DB to point the app at these contracts.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
