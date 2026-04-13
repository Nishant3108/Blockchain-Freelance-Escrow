import { expect } from "chai";
import { ethers } from "ethers";

let hreEthers: any;
let escrow: any;
let deployer: any, client: any, freelancer: any, arbiter: any, attacker: any;

const ONE_ETH = ethers.parseEther("1");
const TWO_ETH = ethers.parseEther("2");
const THREE_ETH = ethers.parseEther("3");

async function getEthers() {
  if (!hreEthers) {
    const hre = await import("hardhat");
    const conn = await (hre.default as any).network.connect();
    hreEthers = conn.ethers;
  }
  return hreEthers;
}

async function deployContract() {
  const eth = await getEthers();
  [deployer, client, freelancer, arbiter, attacker] = await eth.getSigners();
  const Escrow = await eth.getContractFactory("FreelanceEscrow");
  return await Escrow.deploy();
}

describe("FreelanceEscrow", function () {
  this.timeout(60000);

  beforeEach(async function () {
    escrow = await deployContract();
  });

  // --- 1. Deployment ---
  describe("Deployment", function () {
    it("Should start with a jobCounter of 0", async function () {
      expect(await escrow.jobCounter()).to.equal(0n);
    });
  });

  // --- 2. Job Creation ---
  describe("Job Creation", function () {
    it("Should create a job successfully", async function () {
      const milestones = [ONE_ETH, TWO_ETH];
      await expect(
        escrow
          .connect(client)
          .createJob(arbiter.address, milestones, { value: THREE_ETH }),
      )
        .to.emit(escrow, "JobCreated")
        .withArgs(1n, client.address, THREE_ETH, 2n);

      const job = await escrow.jobs(1n);
      expect(job.arbiter).to.equal(arbiter.address);
      expect(job.escrowBalance).to.equal(THREE_ETH);
    });

    it("Should revert if math doesn't match milestones", async function () {
      await expect(
        escrow
          .connect(client)
          .createJob(arbiter.address, [ONE_ETH, TWO_ETH], {
            value: ethers.parseEther("4"),
          }),
      ).to.be.revertedWith("Deposit must match total milestones");
    });

    it("Should revert if client tries to be the arbiter", async function () {
      await expect(
        escrow
          .connect(client)
          .createJob(client.address, [ONE_ETH], { value: ONE_ETH }),
      ).to.be.revertedWith("Client cannot be arbiter");
    });

    it("Should revert if milestone array is empty", async function () {
      await expect(
        escrow
          .connect(client)
          .createJob(arbiter.address, [], { value: ONE_ETH }),
      ).to.be.revertedWith("Must have at least 1 milestone");
    });

    it("Should revert if arbiter is the zero address", async function () {
      await expect(
        escrow
          .connect(client)
          .createJob(ethers.ZeroAddress, [ONE_ETH], { value: ONE_ETH }),
      ).to.be.revertedWith("Invalid arbiter address");
    });

    it("Should revert if any milestone amount is zero", async function () {
      await expect(
        escrow
          .connect(client)
          .createJob(arbiter.address, [ONE_ETH, 0n], { value: ONE_ETH }),
      ).to.be.revertedWith("Each milestone must be > 0");
    });
  });

  // --- 3. Job Cancellation ---
  describe("Job Cancellation", function () {
    beforeEach(async function () {
      await escrow
        .connect(client)
        .createJob(arbiter.address, [ONE_ETH], { value: ONE_ETH });
    });

    it("Should let the client cancel an open job and refund them", async function () {
      const eth = await getEthers();
      const balanceBefore = await eth.provider.getBalance(client.address);
      const tx = await escrow.connect(client).cancelJob(1n);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await eth.provider.getBalance(client.address);

      const job = await escrow.jobs(1n);
      expect(job.state).to.equal(5n);
      expect(job.escrowBalance).to.equal(0n);
      expect(balanceAfter + gasUsed).to.equal(balanceBefore + ONE_ETH);
    });

    it("Should revert if an attacker tries to cancel", async function () {
      await expect(escrow.connect(attacker).cancelJob(1n)).to.be.revertedWith(
        "Only client",
      );
    });

    it("Should revert if job is already IN_PROGRESS", async function () {
      await escrow.connect(freelancer).acceptJob(1n);
      await expect(escrow.connect(client).cancelJob(1n)).to.be.revertedWith(
        "Invalid job state",
      );
    });
  });

  // --- 4. Job Acceptance ---
  describe("Job Acceptance", function () {
    beforeEach(async function () {
      await escrow
        .connect(client)
        .createJob(arbiter.address, [ONE_ETH], { value: ONE_ETH });
    });

    it("Should let a freelancer accept an open job", async function () {
      await expect(escrow.connect(freelancer).acceptJob(1n))
        .to.emit(escrow, "WorkStarted")
        .withArgs(1n, freelancer.address);

      const job = await escrow.jobs(1n);
      expect(job.state).to.equal(1n);
    });

    it("Should prevent the client from accepting their own job", async function () {
      await expect(escrow.connect(client).acceptJob(1n)).to.be.revertedWith(
        "Client cannot be freelancer",
      );
    });

    it("Should revert if the arbiter tries to accept the job", async function () {
      await expect(escrow.connect(arbiter).acceptJob(1n)).to.be.revertedWith(
        "Arbiter cannot be freelancer",
      );
    });

    it("Should revert if the job is already IN_PROGRESS", async function () {
      await escrow.connect(freelancer).acceptJob(1n);
      await expect(escrow.connect(attacker).acceptJob(1n)).to.be.revertedWith(
        "Invalid job state",
      );
    });
  });

  // --- 5 & 6. Milestones and Scope ---
  describe("Milestones and Scope", function () {
    beforeEach(async function () {
      await escrow
        .connect(client)
        .createJob(arbiter.address, [ONE_ETH, ONE_ETH], { value: TWO_ETH });
      await escrow.connect(freelancer).acceptJob(1n);
    });

    it("Should let client approve a milestone and pay freelancer", async function () {
      await expect(escrow.connect(client).approveMilestone(1n))
        .to.emit(escrow, "MilestoneApproved")
        .withArgs(1n, 1n, ONE_ETH);

      const job = await escrow.jobs(1n);
      expect(job.escrowBalance).to.equal(ONE_ETH);
    });

    it("Should mark job COMPLETED after final milestone approved", async function () {
      await escrow.connect(client).approveMilestone(1n);
      await escrow.connect(client).approveMilestone(1n);

      const job = await escrow.jobs(1n);
      expect(job.state).to.equal(2n);
      expect(job.escrowBalance).to.equal(0n);
    });

    it("Should revert if an attacker tries to approve a milestone", async function () {
      await expect(
        escrow.connect(attacker).approveMilestone(1n),
      ).to.be.revertedWith("Only client");
    });

    it("Should revert if client tries to approve when all milestones are done", async function () {
      await escrow.connect(client).approveMilestone(1n);
      await escrow.connect(client).approveMilestone(1n);
      await expect(
        escrow.connect(client).approveMilestone(1n),
      ).to.be.revertedWith("Invalid job state");
    });

    it("Should let client add a new milestone mid-job", async function () {
      await expect(escrow.connect(client).addMilestone(1n, { value: TWO_ETH }))
        .to.emit(escrow, "MilestoneAdded")
        .withArgs(1n, TWO_ETH, 3n);

      const job = await escrow.jobs(1n);
      expect(job.escrowBalance).to.equal(TWO_ETH + TWO_ETH);
    });

    it("Should revert if client adds a milestone but sends 0 ETH", async function () {
      await expect(
        escrow.connect(client).addMilestone(1n, { value: 0n }),
      ).to.be.revertedWith("Must fund the new milestone");
    });

    it("Should let freelancer conclude early after original scope is done", async function () {
      await escrow.connect(client).addMilestone(1n, { value: TWO_ETH });
      await escrow.connect(client).approveMilestone(1n);
      await escrow.connect(client).approveMilestone(1n);

      await expect(escrow.connect(freelancer).concludeJob(1n))
        .to.emit(escrow, "JobConcludedEarly")
        .withArgs(1n, TWO_ETH);
    });

    it("Should revert if freelancer tries to conclude before original scope is done", async function () {
      await escrow.connect(client).approveMilestone(1n);
      await expect(
        escrow.connect(freelancer).concludeJob(1n),
      ).to.be.revertedWith("Original scope not yet complete");
    });
  });

  // --- 7. Tipping ---
  describe("Tipping", function () {
    beforeEach(async function () {
      await escrow
        .connect(client)
        .createJob(arbiter.address, [ONE_ETH], { value: ONE_ETH });
    });

    it("Should send tips directly to the freelancer", async function () {
      const eth = await getEthers();
      await escrow.connect(freelancer).acceptJob(1n);

      const balanceBefore = await eth.provider.getBalance(freelancer.address);
      await escrow.connect(attacker).tipFreelancer(1n, { value: ONE_ETH });
      const balanceAfter = await eth.provider.getBalance(freelancer.address);

      expect(balanceAfter).to.equal(balanceBefore + ONE_ETH);
    });

    it("Should revert if tip is 0", async function () {
      await escrow.connect(freelancer).acceptJob(1n);
      await expect(
        escrow.connect(attacker).tipFreelancer(1n, { value: 0n }),
      ).to.be.revertedWith("Tip must be > 0");
    });

    it("Should revert if tipping before a freelancer is assigned", async function () {
      await expect(
        escrow.connect(attacker).tipFreelancer(1n, { value: ONE_ETH }),
      ).to.be.revertedWith("No freelancer assigned yet");
    });
  });

  // --- 8. Dispute Resolution ---
  describe("Disputes", function () {
    beforeEach(async function () {
      await escrow
        .connect(client)
        .createJob(arbiter.address, [TWO_ETH], { value: TWO_ETH });
      await escrow.connect(freelancer).acceptJob(1n);
    });

    it("Should allow client to raise a dispute", async function () {
      await expect(escrow.connect(client).raiseDispute(1n))
        .to.emit(escrow, "DisputeRaised")
        .withArgs(1n, client.address);

      const job = await escrow.jobs(1n);
      expect(job.state).to.equal(3n);
    });

    it("Should allow freelancer to raise a dispute", async function () {
      await expect(escrow.connect(freelancer).raiseDispute(1n))
        .to.emit(escrow, "DisputeRaised")
        .withArgs(1n, freelancer.address);
    });

    it("Should revert if an attacker tries to raise a dispute", async function () {
      await expect(
        escrow.connect(attacker).raiseDispute(1n),
      ).to.be.revertedWith("Only client or freelancer");
    });

    it("Should let arbiter split funds 50/50", async function () {
      await escrow.connect(client).raiseDispute(1n);
      await expect(escrow.connect(arbiter).resolveDispute(1n, ONE_ETH, ONE_ETH))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(1n, ONE_ETH, ONE_ETH);

      const job = await escrow.jobs(1n);
      expect(job.state).to.equal(4n);
      expect(job.escrowBalance).to.equal(0n);
    });

    it("Should let arbiter give 100% to client", async function () {
      await escrow.connect(client).raiseDispute(1n);
      await expect(escrow.connect(arbiter).resolveDispute(1n, TWO_ETH, 0n))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(1n, TWO_ETH, 0n);
    });

    it("Should let arbiter give 100% to freelancer", async function () {
      await escrow.connect(client).raiseDispute(1n);
      await expect(escrow.connect(arbiter).resolveDispute(1n, 0n, TWO_ETH))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(1n, 0n, TWO_ETH);
    });

    it("Should revert if anyone other than arbiter tries to resolve", async function () {
      await escrow.connect(client).raiseDispute(1n);
      await expect(
        escrow.connect(attacker).resolveDispute(1n, ONE_ETH, ONE_ETH),
      ).to.be.revertedWith("Only arbiter");
    });

    it("Should reject bad math from the arbiter", async function () {
      await escrow.connect(freelancer).raiseDispute(1n);
      await expect(
        escrow.connect(arbiter).resolveDispute(1n, TWO_ETH, ONE_ETH),
      ).to.be.revertedWith("Amounts must equal remaining balance");
    });
  });
});
