const hre = require("hardhat");
const { ethers } = require("hardhat");

async function main() {
  console.log("🚀 Starting deployment...\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("📍 Deploying from account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", ethers.formatEther(balance), "ETH\n");

  // Fee configuration from environment
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const feeBps = parseInt(process.env.FEE_BPS || "500"); // Default 5%

  console.log("📋 Factory Configuration:");
  console.log("   Fee Recipient:", feeRecipient);
  console.log("   Fee (bps):", feeBps, `(${feeBps / 100}%)`);
  console.log("");

  // Deploy WaterfallFactory
  console.log("📄 Deploying WaterfallFactory...");
  const FactoryContract = await ethers.getContractFactory("WaterfallFactory");
  const factory = await FactoryContract.deploy(feeRecipient, feeBps);

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("✅ Factory deployed to:", factoryAddress);
  console.log("");

  // Optionally create a first project through the factory
  const projectName = process.env.PROJECT_NAME;
  // URI parameter removed — metadata is generated on-chain by uri()
  let projectAddress = null;

  if (projectName) {
    const paymentToken = process.env.PAYMENT_TOKEN || ethers.ZeroAddress;
    console.log("📄 Creating project:", projectName, paymentToken === ethers.ZeroAddress ? "(ETH)" : `(token: ${paymentToken})`);
    const tx = await factory.createProject(projectName, paymentToken);
    const receipt = await tx.wait();

    const projects = await factory.getProjectsByOwner(deployer.address);
    projectAddress = projects[projects.length - 1];
    console.log("✅ Project deployed to:", projectAddress);
    console.log("");
  }

  // Save deployment info
  const deploymentInfo = {
    network: hre.network.name,
    factoryAddress: factoryAddress,
    projectAddress: projectAddress,
    deployer: deployer.address,
    feeRecipient: feeRecipient,
    feeBps: feeBps,
    timestamp: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber()
  };

  console.log("📦 Deployment Summary:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
  console.log("");

  // Wait for block confirmations on testnet/mainnet
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("⏳ Waiting for 5 block confirmations...");
    await factory.deploymentTransaction().wait(5);
    console.log("✅ Confirmed!\n");

    // Verify on Etherscan if API key is provided
    if (process.env.ETHERSCAN_API_KEY) {
      console.log("🔍 Verifying factory on Etherscan...");
      try {
        await hre.run("verify:verify", {
          address: factoryAddress,
          constructorArguments: [feeRecipient, feeBps],
        });
        console.log("✅ Factory verified on Etherscan");
      } catch (error) {
        console.log("⚠️  Verification failed:", error.message);
      }
    }
  }

  console.log("\n🎉 Deployment complete!");
  console.log("\n📝 Next steps:");
  console.log("   1. Save the factory address:", factoryAddress);
  console.log("   2. Create projects: factory.createProject('Film Name', paymentToken)");
  console.log("      - paymentToken = address(0) for ETH, or an ERC20 address (e.g. USDC)");
  console.log("      - Each project is denominated in exactly one token. All tier caps,");
  console.log("        deposits, and withdrawals use that single unit of account.");
  console.log("   3. Set up tiers on each project using createPriority()");
  console.log("   4. Start depositing revenue with depositRevenue() (ETH) or depositRevenue(amount) (ERC20)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
