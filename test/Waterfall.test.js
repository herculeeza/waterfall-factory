const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WaterfallRevenueDistribution", function () {
  let waterfall;
  let owner, investor1, investor2, soundDesigner, editor, manager, cinematographer, feeWallet;

  beforeEach(async function () {
    // Get signers
    [owner, investor1, investor2, soundDesigner, editor, manager, cinematographer, feeWallet] = await ethers.getSigners();

    // Deploy contract with no fee (preserves existing test math)
    const WaterfallContract = await ethers.getContractFactory("Waterfall");
    waterfall = await WaterfallContract.deploy("Test Project", "https://test.com/", ethers.ZeroAddress, ethers.ZeroAddress, 0);
    await waterfall.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct project name", async function () {
      expect(await waterfall.projectName()).to.equal("Test Project");
    });

    it("Should set the owner correctly", async function () {
      expect(await waterfall.owner()).to.equal(owner.address);
    });

    it("Should set fee parameters", async function () {
      expect(await waterfall.paymentToken()).to.equal(ethers.ZeroAddress);
      expect(await waterfall.feeRecipient()).to.equal(ethers.ZeroAddress);
      expect(await waterfall.feeBps()).to.equal(0);
    });

    it("Should reject fee > 10%", async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      await expect(
        WaterfallContract.deploy("Test", "https://test.com/", ethers.ZeroAddress, feeWallet.address, 1001)
      ).to.be.revertedWith("Fee cannot exceed 10%");
    });

    it("Should reject fee > 0 with zero recipient", async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      await expect(
        WaterfallContract.deploy("Test", "https://test.com/", ethers.ZeroAddress, ethers.ZeroAddress, 500)
      ).to.be.revertedWith("Fee recipient required when fee > 0");
    });
  });

  describe("Priority Creation", function () {
    it("Should create capped tier correctly", async function () {
      const tokenId = 0;
      const priority = 0;
      const holders = [investor1.address, investor2.address];
      const amounts = [ethers.parseEther("80000"), ethers.parseEther("40000")];
      const total = ethers.parseEther("120000");

      await waterfall.createPriority(tokenId, priority, total, total, holders, amounts);

      // Check token balances
      expect(await waterfall.balanceOf(investor1.address, tokenId)).to.equal(ethers.parseEther("80000"));
      expect(await waterfall.balanceOf(investor2.address, tokenId)).to.equal(ethers.parseEther("40000"));

      // Check priority info
      const info = await waterfall.getPriorityInfo(tokenId);
      expect(info.exists).to.be.true;
      expect(info.totalSupply).to.equal(total);
      expect(info.maxAmount).to.equal(total); // Capped at total
    });

    it("Should create uncapped tier correctly", async function () {
      const tokenId = 99;
      const priority = 3;
      const holders = [manager.address, cinematographer.address];
      const shares = [400000, 600000]; // 40%, 60%
      const totalShares = 1000000;

      await waterfall.createPriority(tokenId, priority, totalShares, 0, holders, shares);

      // Check token balances
      expect(await waterfall.balanceOf(manager.address, tokenId)).to.equal(400000);
      expect(await waterfall.balanceOf(cinematographer.address, tokenId)).to.equal(600000);

      // Check priority info
      const info = await waterfall.getPriorityInfo(tokenId);
      expect(info.exists).to.be.true;
      expect(info.maxAmount).to.equal(0); // Uncapped
    });

    it("Should reject duplicate priority values", async function () {
      const holders = [investor1.address];
      const amounts = [ethers.parseEther("10000")];
      const total = ethers.parseEther("10000");

      await waterfall.createPriority(0, 0, total, total, holders, amounts);

      await expect(
        waterfall.createPriority(1, 0, total, total, holders, amounts)
      ).to.be.revertedWith("Priority value already used");
    });

    it("Should reject creating duplicate token IDs", async function () {
      const tokenId = 0;
      const holders = [investor1.address];
      const amounts = [ethers.parseEther("10000")];
      const total = ethers.parseEther("10000");

      await waterfall.createPriority(tokenId, 0, total, total, holders, amounts);

      await expect(
        waterfall.createPriority(tokenId, 0, total, total, holders, amounts)
      ).to.be.revertedWith("Token ID already exists");
    });
  });

  describe("Finalization", function () {
    it("Should reject finalization without an uncapped tier", async function () {
      await waterfall.createPriority(
        0, 0,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        [investor1.address],
        [ethers.parseEther("100000")]
      );

      await expect(waterfall.finalize()).to.be.revertedWith("Must have an uncapped tier");
    });

    it("Should reject deposits before finalization", async function () {
      await waterfall.createPriority(
        0, 0,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        [investor1.address],
        [ethers.parseEther("100000")]
      );

      await waterfall.createPriority(99, 1, 1000000, 0, [manager.address], [1000000]);

      await expect(
        waterfall["depositRevenue()"]({ value: ethers.parseEther("1") })
      ).to.be.revertedWith("Waterfall not finalized");
    });

    it("Should reject ERC20 deposits before finalization", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("Test", "TST", 18);
      await token.waitForDeployment();

      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      const tokenWaterfall = await WaterfallContract.deploy(
        "Token Project", "https://test.com/",
        await token.getAddress(),
        ethers.ZeroAddress, 0
      );
      await tokenWaterfall.waitForDeployment();

      await tokenWaterfall.createPriority(0, 0, 1000, 1000, [investor1.address], [1000]);
      await tokenWaterfall.createPriority(99, 1, 1000, 0, [investor1.address], [1000]);

      await token.mint(owner.address, 1000);
      await token.approve(await tokenWaterfall.getAddress(), 1000);

      await expect(
        tokenWaterfall["depositRevenue(uint256)"](1000)
      ).to.be.revertedWith("Waterfall not finalized");
    });
  });

  describe("Waterfall Distribution", function () {
    beforeEach(async function () {
      // Set up Urban Echoes scenario
      // Priority 0: $120k capped tier (tokenId 0)
      await waterfall.createPriority(
        0, // tokenId
        0, // priority
        ethers.parseEther("120000"),
        ethers.parseEther("120000"), // maxAmount = cap
        [investor1.address, investor2.address],
        [ethers.parseEther("80000"), ethers.parseEther("40000")]
      );

      // Priority 1: $80k capped tier (tokenId 1)
      await waterfall.createPriority(
        1, // tokenId
        1, // priority
        ethers.parseEther("80000"),
        ethers.parseEther("80000"), // maxAmount = cap
        [soundDesigner.address, editor.address],
        [ethers.parseEther("50000"), ethers.parseEther("30000")]
      );

      // Priority 3: Uncapped tier (tokenId 99)
      await waterfall.createPriority(
        99, // tokenId
        3,  // priority
        1000000,
        0,  // maxAmount = 0 (uncapped)
        [manager.address, cinematographer.address],
        [400000, 600000] // 40%, 60%
      );

      await waterfall.finalize();
    });

    it("Should distribute revenue correctly when Priority 0 is fully paid", async function () {
      // Deposit $140k revenue
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("140000") });

      // Priority 0 should be fully paid
      expect(await waterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(ethers.parseEther("80000"));
      expect(await waterfall.getAvailableBalance(investor2.address, 0))
        .to.equal(ethers.parseEther("40000"));

      // Priority 1 should be partially paid ($20k / $80k = 25%)
      expect(await waterfall.getAvailableBalance(soundDesigner.address, 1))
        .to.equal(ethers.parseEther("12500")); // 50k * 25% = 12.5k
      expect(await waterfall.getAvailableBalance(editor.address, 1))
        .to.equal(ethers.parseEther("7500")); // 30k * 25% = 7.5k

      // Priority 3 equity should get nothing (debt not fully paid)
      expect(await waterfall.getAvailableBalance(manager.address, 99))
        .to.equal(0);
    });

    it("Should allow withdrawals", async function () {
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("140000") });

      // Investor1 withdraws
      const balanceBefore = await ethers.provider.getBalance(investor1.address);
      const tx = await waterfall.connect(investor1).withdraw(0);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(investor1.address);

      expect(balanceAfter - balanceBefore + gasCost).to.equal(ethers.parseEther("80000"));

      // Balance should now be 0
      expect(await waterfall.getAvailableBalance(investor1.address, 0)).to.equal(0);
    });

    it("Should require withdrawal before transfer", async function () {
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("140000") });

      // Sound designer has earnings
      const availableBefore = await waterfall.getAvailableBalance(soundDesigner.address, 1);
      expect(availableBefore).to.be.gt(0);

      // Attempting to transfer without withdrawing should fail
      await expect(
        waterfall.connect(soundDesigner).safeTransferFrom(
          soundDesigner.address,
          cinematographer.address,
          1,
          ethers.parseEther("50000"),
          "0x"
        )
      ).to.be.revertedWith("Must withdraw all earnings before transfer");

      // Sound designer withdraws their share
      await waterfall.connect(soundDesigner).withdraw(1);
      expect(await waterfall.getAvailableBalance(soundDesigner.address, 1)).to.equal(0);

      // Now transfer should succeed
      await waterfall.connect(soundDesigner).safeTransferFrom(
        soundDesigner.address,
        cinematographer.address,
        1,
        ethers.parseEther("50000"),
        "0x"
      );

      // New holder should NOT be able to claim old earnings
      expect(await waterfall.getAvailableBalance(cinematographer.address, 1)).to.equal(0);

      // Deposit more revenue
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("60000") });

      // Priority 1 gets $60k more (now $80k total), which fully pays it
      // New holder should get their proportional share of NEW earnings only
      // NEW earnings for P1 = $60k, their share = (50k/80k) * 60k = $37.5k
      expect(await waterfall.getAvailableBalance(cinematographer.address, 1))
        .to.equal(ethers.parseEther("37500"));
    });

    it("Should accrue receiver's existing position on transfer", async function () {
      // Give cinematographer some tokens from Priority 1
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("140000") });

      // Editor withdraws and transfers to cinematographer
      await waterfall.connect(editor).withdraw(1);
      await waterfall.connect(editor).safeTransferFrom(
        editor.address,
        cinematographer.address,
        1,
        ethers.parseEther("30000"),
        "0x"
      );

      // Cinematographer now has 30k tokens
      expect(await waterfall.balanceOf(cinematographer.address, 1)).to.equal(ethers.parseEther("30000"));

      // Deposit more revenue
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("80000") });

      // Priority 1 has $60k remaining capacity ($80k cap - $20k already earned).
      // The $80k deposit fills that $60k, making P1 fully paid; P99 gets the $20k remainder.
      // Cinematographer's 30k tokens earn: (30k/80k) * $60k = $22.5k
      const available = await waterfall.getAvailableBalance(cinematographer.address, 1);
      expect(available).to.equal(ethers.parseEther("22500"));

      // Now sound designer (who still has 50k tokens) withdraws and transfers to cinematographer
      await waterfall.connect(soundDesigner).withdraw(1);
      await waterfall.connect(soundDesigner).safeTransferFrom(
        soundDesigner.address,
        cinematographer.address,
        1,
        ethers.parseEther("50000"),
        "0x"
      );

      // Cinematographer should still have their $22.5k available (accrued during transfer hook)
      expect(await waterfall.getAvailableBalance(cinematographer.address, 1)).to.equal(ethers.parseEther("22500"));

      // Cinematographer now has 80k tokens total
      expect(await waterfall.balanceOf(cinematographer.address, 1)).to.equal(ethers.parseEther("80000"));

      // Deposit more revenue
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("100000") });

      // P1 was fully paid after the second deposit — this $100k goes entirely to P99.
      // Cinematographer retains their accrued $22.5k; P1 cumulativeEPT doesn't move.
      expect(await waterfall.getAvailableBalance(cinematographer.address, 1))
        .to.equal(ethers.parseEther("22500"));
    });

    it("Should distribute to equity after all debt is paid", async function () {
      // Deposit $250k to fully pay all debt
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("250000") });

      // Priority 0: $120k (fully paid)
      expect(await waterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(ethers.parseEther("80000"));

      // Priority 1: $80k (fully paid)
      expect(await waterfall.getAvailableBalance(soundDesigner.address, 1))
        .to.equal(ethers.parseEther("50000"));

      // Priority 3 equity: $50k remaining split 40/60
      expect(await waterfall.getAvailableBalance(manager.address, 99))
        .to.equal(ethers.parseEther("20000")); // 40% of 50k
      expect(await waterfall.getAvailableBalance(cinematographer.address, 99))
        .to.equal(ethers.parseEther("30000")); // 60% of 50k
    });
  });

  describe("Batch Operations", function () {
    beforeEach(async function () {
      // Create multiple capped tiers
      await waterfall.createPriority(
        0, // tokenId
        0, // priority
        ethers.parseEther("100000"),
        ethers.parseEther("100000"), // maxAmount = cap
        [investor1.address],
        [ethers.parseEther("100000")]
      );

      await waterfall.createPriority(
        1, // tokenId
        1, // priority
        ethers.parseEther("50000"),
        ethers.parseEther("50000"), // maxAmount = cap
        [investor1.address],
        [ethers.parseEther("50000")]
      );

      await waterfall.createPriority(
        99, 2, 1000000, 0,
        [manager.address],
        [1000000]
      );

      await waterfall.finalize();
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("200000") });
    });

    it("Should allow batch withdrawals", async function () {
      const balanceBefore = await ethers.provider.getBalance(investor1.address);

      const tx = await waterfall.connect(investor1).withdrawBatch([0, 1]);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(investor1.address);

      // Should withdraw $100k + $50k = $150k
      expect(balanceAfter - balanceBefore + gasCost).to.equal(ethers.parseEther("150000"));
    });
  });

  describe("Platform Fee", function () {
    let feeWaterfall;

    beforeEach(async function () {
      // Deploy with 5% fee
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      feeWaterfall = await WaterfallContract.deploy("Fee Project", "https://test.com/", ethers.ZeroAddress, feeWallet.address, 500);
      await feeWaterfall.waitForDeployment();

      // Create a capped tier and uncapped equity tier
      await feeWaterfall.createPriority(
        0, 0,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        [investor1.address],
        [ethers.parseEther("100000")]
      );

      await feeWaterfall.createPriority(
        99, 1, 1000000, 0,
        [manager.address, cinematographer.address],
        [400000, 600000]
      );

      await feeWaterfall.finalize();
    });

    it("Should skim 5% fee on deposit", async function () {
      const depositAmount = ethers.parseEther("100000");
      const expectedFee = ethers.parseEther("5000");   // 5%
      const expectedNet = ethers.parseEther("95000");   // 95%

      const feeBalanceBefore = await ethers.provider.getBalance(feeWallet.address);

      await feeWaterfall["depositRevenue()"]({ value: depositAmount });

      const feeBalanceAfter = await ethers.provider.getBalance(feeWallet.address);

      // Fee recipient should have received 5%
      expect(feeBalanceAfter - feeBalanceBefore).to.equal(expectedFee);

      // Contract should track net revenue
      expect(await feeWaterfall.totalRevenue()).to.equal(expectedNet);
      expect(await feeWaterfall.totalFeesCollected()).to.equal(expectedFee);

      // Participant should only see net amount
      expect(await feeWaterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(expectedNet);
    });

    it("Should distribute net revenue correctly through waterfall", async function () {
      // Deposit $200k gross → $190k net (5% = $10k fee)
      // P0 cap is $100k → fully paid, $90k cascades to equity
      await feeWaterfall["depositRevenue()"]({ value: ethers.parseEther("200000") });

      // Debt tier fully paid at $100k
      expect(await feeWaterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(ethers.parseEther("100000"));

      // Equity gets remaining $90k split 40/60
      expect(await feeWaterfall.getAvailableBalance(manager.address, 99))
        .to.equal(ethers.parseEther("36000"));  // 40% of $90k
      expect(await feeWaterfall.getAvailableBalance(cinematographer.address, 99))
        .to.equal(ethers.parseEther("54000"));  // 60% of $90k
    });

    it("Should handle zero fee correctly", async function () {
      // The main waterfall (no fee) should pass full amount through
      await waterfall.createPriority(
        0, 0,
        ethers.parseEther("50000"),
        ethers.parseEther("50000"),
        [investor1.address],
        [ethers.parseEther("50000")]
      );

      await waterfall.createPriority(
        99, 1, 1000000, 0,
        [manager.address],
        [1000000]
      );

      await waterfall.finalize();
      await waterfall["depositRevenue()"]({ value: ethers.parseEther("50000") });

      expect(await waterfall.totalRevenue()).to.equal(ethers.parseEther("50000"));
      expect(await waterfall.totalFeesCollected()).to.equal(0);
    });
  });
});

describe("WaterfallFactory", function () {
  let factory;
  let owner, user1, user2, feeWallet;

  beforeEach(async function () {
    [owner, user1, user2, feeWallet] = await ethers.getSigners();

    const FactoryContract = await ethers.getContractFactory("WaterfallFactory");
    factory = await FactoryContract.deploy(feeWallet.address, 500); // 5% fee
    await factory.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set default fee parameters", async function () {
      expect(await factory.defaultFeeRecipient()).to.equal(feeWallet.address);
      expect(await factory.defaultFeeBps()).to.equal(500);
    });

    it("Should set factory owner", async function () {
      expect(await factory.owner()).to.equal(owner.address);
    });
  });

  describe("Project Creation", function () {
    it("Should deploy a new Waterfall project", async function () {
      const tx = await factory.connect(user1).createProject("My Film", "https://example.com/", ethers.ZeroAddress);
      const receipt = await tx.wait();

      // Should have one project
      expect(await factory.projectCount()).to.equal(1);

      // Get the project address from the registry
      const projects = await factory.getProjectsByOwner(user1.address);
      expect(projects.length).to.equal(1);

      // Verify the deployed contract
      const waterfall = await ethers.getContractAt("Waterfall", projects[0]);
      expect(await waterfall.projectName()).to.equal("My Film");
      expect(await waterfall.feeRecipient()).to.equal(feeWallet.address);
      expect(await waterfall.feeBps()).to.equal(500);
      expect(await waterfall.owner()).to.equal(user1.address);
    });

    it("Should track multiple projects per owner", async function () {
      await factory.connect(user1).createProject("Film A", "https://a.com/", ethers.ZeroAddress);
      await factory.connect(user1).createProject("Film B", "https://b.com/", ethers.ZeroAddress);
      await factory.connect(user2).createProject("Film C", "https://c.com/", ethers.ZeroAddress);

      expect(await factory.projectCount()).to.equal(3);

      const user1Projects = await factory.getProjectsByOwner(user1.address);
      expect(user1Projects.length).to.equal(2);

      const user2Projects = await factory.getProjectsByOwner(user2.address);
      expect(user2Projects.length).to.equal(1);

      const allProjects = await factory.getAllProjects();
      expect(allProjects.length).to.equal(3);
    });

    it("Should allow project owner to create tiers", async function () {
      await factory.connect(user1).createProject("My Film", "https://example.com/", ethers.ZeroAddress);
      const projects = await factory.getProjectsByOwner(user1.address);
      const waterfall = await ethers.getContractAt("Waterfall", projects[0]);

      // user1 (project owner) can create a tier
      await waterfall.connect(user1).createPriority(
        0, 0,
        ethers.parseEther("50000"),
        ethers.parseEther("50000"),
        [user2.address],
        [ethers.parseEther("50000")]
      );

      expect((await waterfall.getPriorityInfo(0)).exists).to.be.true;
    });

    it("Should not allow non-owner to create tiers", async function () {
      await factory.connect(user1).createProject("My Film", "https://example.com/", ethers.ZeroAddress);
      const projects = await factory.getProjectsByOwner(user1.address);
      const waterfall = await ethers.getContractAt("Waterfall", projects[0]);

      // user2 (not owner) cannot create a tier
      await expect(
        waterfall.connect(user2).createPriority(
          0, 0,
          ethers.parseEther("50000"),
          ethers.parseEther("50000"),
          [user1.address],
          [ethers.parseEther("50000")]
        )
      ).to.be.revertedWithCustomError(waterfall, "OwnableUnauthorizedAccount");
    });
  });

  describe("Fee Management", function () {
    it("Should allow factory owner to update default fee", async function () {
      await factory.setDefaultFee(user2.address, 300); // 3%
      expect(await factory.defaultFeeRecipient()).to.equal(user2.address);
      expect(await factory.defaultFeeBps()).to.equal(300);
    });

    it("Should not allow non-owner to update fee", async function () {
      await expect(
        factory.connect(user1).setDefaultFee(user1.address, 300)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("Should apply updated fee to new projects only", async function () {
      // Create project with original 5% fee
      await factory.connect(user1).createProject("Film A", "https://a.com/", ethers.ZeroAddress);

      // Update fee to 3%
      await factory.setDefaultFee(feeWallet.address, 300);

      // Create project with new 3% fee
      await factory.connect(user1).createProject("Film B", "https://b.com/", ethers.ZeroAddress);

      const projects = await factory.getProjectsByOwner(user1.address);
      const waterfallA = await ethers.getContractAt("Waterfall", projects[0]);
      const waterfallB = await ethers.getContractAt("Waterfall", projects[1]);

      // Film A should still have 5% fee
      expect(await waterfallA.feeBps()).to.equal(500);

      // Film B should have the new 3% fee
      expect(await waterfallB.feeBps()).to.equal(300);
    });
  });
});

describe("Waterfall ERC20 Support", function () {
  let waterfall, usdc, dai;
  let owner, investor1, investor2, manager, cinematographer, feeWallet;

  beforeEach(async function () {
    [owner, investor1, investor2, manager, cinematographer, feeWallet] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals) and DAI (18 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);
    await usdc.waitForDeployment();
    await dai.waitForDeployment();
  });

  describe("USDC (6 decimals)", function () {
    let usdcWaterfall;
    const USDC = (n) => BigInt(n) * 10n ** 6n; // helper for 6-decimal amounts

    beforeEach(async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      usdcWaterfall = await WaterfallContract.deploy(
        "USDC Film", "https://test.com/",
        await usdc.getAddress(),
        ethers.ZeroAddress, 0
      );
      await usdcWaterfall.waitForDeployment();

      // Create tiers
      await usdcWaterfall.createPriority(
        0, 0,
        USDC(120000), USDC(120000),
        [investor1.address, investor2.address],
        [USDC(80000), USDC(40000)]
      );

      await usdcWaterfall.createPriority(
        99, 1, 1000000, 0,
        [manager.address, cinematographer.address],
        [400000, 600000]
      );

      await usdcWaterfall.finalize();

      // Mint USDC to owner for deposits
      await usdc.mint(owner.address, USDC(1000000));
      await usdc.approve(await usdcWaterfall.getAddress(), USDC(1000000));
    });

    it("Should accept USDC deposits via depositRevenue(amount)", async function () {
      await usdcWaterfall["depositRevenue(uint256)"](USDC(100000));
      expect(await usdcWaterfall.totalRevenue()).to.equal(USDC(100000));
    });

    it("Should reject ETH sent to USDC waterfall", async function () {
      await expect(
        usdcWaterfall["depositRevenue()"]({ value: ethers.parseEther("1") })
      ).to.be.revertedWith("Use depositRevenue(amount) for token deposits");
    });

    it("Should reject depositRevenue(amount) with ETH value", async function () {
      await expect(
        usdcWaterfall["depositRevenue(uint256)"](USDC(100), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Do not send ETH for token deposits");
    });

    it("Should distribute USDC through waterfall correctly", async function () {
      // Deposit $200k USDC — fills $120k cap, $80k to equity
      await usdcWaterfall["depositRevenue(uint256)"](USDC(200000));

      // Investor1: 80k/120k of capped tier = $80k
      expect(await usdcWaterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(USDC(80000));

      // Investor2: 40k/120k of capped tier = $40k
      expect(await usdcWaterfall.getAvailableBalance(investor2.address, 0))
        .to.equal(USDC(40000));

      // Manager: 40% of $80k equity = $32k
      expect(await usdcWaterfall.getAvailableBalance(manager.address, 99))
        .to.equal(USDC(32000));
    });

    it("Should allow USDC withdrawals", async function () {
      await usdcWaterfall["depositRevenue(uint256)"](USDC(200000));

      const balanceBefore = await usdc.balanceOf(investor1.address);
      await usdcWaterfall.connect(investor1).withdraw(0);
      const balanceAfter = await usdc.balanceOf(investor1.address);

      expect(balanceAfter - balanceBefore).to.equal(USDC(80000));
      expect(await usdcWaterfall.getAvailableBalance(investor1.address, 0)).to.equal(0);
    });

    it("Should allow USDC batch withdrawals", async function () {
      // Give investor1 tokens in both tiers for batch test
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      const batchWaterfall = await WaterfallContract.deploy(
        "Batch USDC", "https://test.com/",
        await usdc.getAddress(),
        ethers.ZeroAddress, 0
      );
      await batchWaterfall.waitForDeployment();

      await batchWaterfall.createPriority(0, 0, USDC(100000), USDC(100000), [investor1.address], [USDC(100000)]);
      await batchWaterfall.createPriority(1, 1, USDC(50000), USDC(50000), [investor1.address], [USDC(50000)]);
      await batchWaterfall.createPriority(99, 2, 1000000, 0, [manager.address], [1000000]);
      await batchWaterfall.finalize();

      await usdc.approve(await batchWaterfall.getAddress(), USDC(200000));
      await batchWaterfall["depositRevenue(uint256)"](USDC(200000));

      const balanceBefore = await usdc.balanceOf(investor1.address);
      await batchWaterfall.connect(investor1).withdrawBatch([0, 1]);
      const balanceAfter = await usdc.balanceOf(investor1.address);

      expect(balanceAfter - balanceBefore).to.equal(USDC(150000));
    });

    it("Should report USDC contract balance", async function () {
      await usdcWaterfall["depositRevenue(uint256)"](USDC(100000));
      expect(await usdcWaterfall.getContractBalance()).to.equal(USDC(100000));
    });
  });

  describe("DAI (18 decimals)", function () {
    let daiWaterfall;

    beforeEach(async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      daiWaterfall = await WaterfallContract.deploy(
        "DAI Film", "https://test.com/",
        await dai.getAddress(),
        ethers.ZeroAddress, 0
      );
      await daiWaterfall.waitForDeployment();

      await daiWaterfall.createPriority(
        0, 0,
        ethers.parseEther("100000"), ethers.parseEther("100000"),
        [investor1.address],
        [ethers.parseEther("100000")]
      );

      await daiWaterfall.createPriority(
        99, 1, 1000000, 0,
        [manager.address],
        [1000000]
      );

      await daiWaterfall.finalize();

      await dai.mint(owner.address, ethers.parseEther("500000"));
      await dai.approve(await daiWaterfall.getAddress(), ethers.parseEther("500000"));
    });

    it("Should accept DAI deposits and distribute correctly", async function () {
      await daiWaterfall["depositRevenue(uint256)"](ethers.parseEther("100000"));
      expect(await daiWaterfall.getAvailableBalance(investor1.address, 0))
        .to.equal(ethers.parseEther("100000"));
    });

    it("Should allow DAI withdrawals", async function () {
      await daiWaterfall["depositRevenue(uint256)"](ethers.parseEther("100000"));

      const balanceBefore = await dai.balanceOf(investor1.address);
      await daiWaterfall.connect(investor1).withdraw(0);
      const balanceAfter = await dai.balanceOf(investor1.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("100000"));
    });
  });

  describe("ERC20 with platform fee", function () {
    let feeWaterfall;
    const USDC = (n) => BigInt(n) * 10n ** 6n;

    beforeEach(async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      feeWaterfall = await WaterfallContract.deploy(
        "Fee USDC Film", "https://test.com/",
        await usdc.getAddress(),
        feeWallet.address, 500 // 5% fee
      );
      await feeWaterfall.waitForDeployment();

      await feeWaterfall.createPriority(
        0, 0,
        USDC(100000), USDC(100000),
        [investor1.address],
        [USDC(100000)]
      );

      await feeWaterfall.createPriority(
        99, 1, 1000000, 0,
        [manager.address],
        [1000000]
      );

      await feeWaterfall.finalize();

      await usdc.mint(owner.address, USDC(200000));
      await usdc.approve(await feeWaterfall.getAddress(), USDC(200000));
    });

    it("Should skim 5% USDC fee on deposit", async function () {
      const feeBalanceBefore = await usdc.balanceOf(feeWallet.address);

      await feeWaterfall["depositRevenue(uint256)"](USDC(100000));

      const feeBalanceAfter = await usdc.balanceOf(feeWallet.address);
      expect(feeBalanceAfter - feeBalanceBefore).to.equal(USDC(5000)); // 5%
      expect(await feeWaterfall.totalRevenue()).to.equal(USDC(95000));
      expect(await feeWaterfall.totalFeesCollected()).to.equal(USDC(5000));
    });
  });

  describe("Rescue tokens", function () {
    let usdcWaterfall;
    const USDC = (n) => BigInt(n) * 10n ** 6n;

    beforeEach(async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      usdcWaterfall = await WaterfallContract.deploy(
        "USDC Film", "https://test.com/",
        await usdc.getAddress(),
        ethers.ZeroAddress, 0
      );
      await usdcWaterfall.waitForDeployment();
    });

    it("Should allow owner to rescue accidentally-sent tokens", async function () {
      // Accidentally send DAI to the USDC waterfall
      await dai.mint(owner.address, ethers.parseEther("1000"));
      await dai.transfer(await usdcWaterfall.getAddress(), ethers.parseEther("1000"));

      // Rescue the DAI
      await usdcWaterfall.rescueTokens(
        await dai.getAddress(),
        owner.address,
        ethers.parseEther("1000")
      );

      expect(await dai.balanceOf(owner.address)).to.equal(ethers.parseEther("1000"));
    });

    it("Should not allow rescuing the payment token", async function () {
      await usdc.mint(await usdcWaterfall.getAddress(), USDC(1000));

      await expect(
        usdcWaterfall.rescueTokens(await usdc.getAddress(), owner.address, USDC(1000))
      ).to.be.revertedWith("Cannot rescue payment token");
    });

    it("Should not allow non-owner to rescue tokens", async function () {
      await dai.mint(await usdcWaterfall.getAddress(), ethers.parseEther("1000"));

      await expect(
        usdcWaterfall.connect(investor1).rescueTokens(
          await dai.getAddress(),
          investor1.address,
          ethers.parseEther("1000")
        )
      ).to.be.revertedWithCustomError(usdcWaterfall, "OwnableUnauthorizedAccount");
    });
  });

  describe("ETH waterfall rejects amount parameter", function () {
    it("Should reject depositRevenue(amount) on ETH waterfall", async function () {
      const WaterfallContract = await ethers.getContractFactory("Waterfall");
      const ethWaterfall = await WaterfallContract.deploy(
        "ETH Project", "https://test.com/",
        ethers.ZeroAddress,
        ethers.ZeroAddress, 0
      );
      await ethWaterfall.waitForDeployment();

      await ethWaterfall.createPriority(0, 0, 1000, 1000, [investor1.address], [1000]);
      await ethWaterfall.createPriority(99, 1, 1000, 0, [investor1.address], [1000]);
      await ethWaterfall.finalize();

      await expect(
        ethWaterfall["depositRevenue(uint256)"](1000, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Do not pass amount for ETH deposits");
    });
  });
});
