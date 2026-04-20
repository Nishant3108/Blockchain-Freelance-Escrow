# FreelanceEscrow — Decentralized Freelance Payment System

> A trustless escrow smart contract built on Ethereum that replaces middlemen like Upwork or Fiverr. Clients lock ETH on-chain, freelancers complete milestones to earn payment, and a trusted arbiter resolves disputes — all without a central authority.

**Contract on Sepolia:** 0x5b4e2819cF58DD50809a8eE904618e5227F76B0E 

**Etherscan:** https://sepolia.etherscan.io/address/0x5b4e2819cF58DD50809a8eE904618e5227F76B0E 

**Transaction Hash:** 0x38e002E37ff6bE9c14F160007F4a8c1FC2412dDd

---

## What Problem Does This Solve?

Traditional freelance platforms like Upwork and Fiverr have serious problems:

- They take **10–20% fees** on every transaction
- They can **freeze your account** or reverse payments arbitrarily
- You have to **trust a company** to hold your money and resolve disputes fairly
- Payments can take **days to clear**

Our smart contract solves all of this. Once deployed, the rules are coded on-chain and **nobody can change them** — not us, not Anthropic, not anyone. ETH is locked in the contract itself and only moves when the coded conditions are met.

---

## How It Works

### The Three Actors

| Role | Who They Are | What They Do |
|---|---|---|
| **Client** | The person hiring | Posts the job, locks ETH, approves milestones |
| **Freelancer** | The person working | Accepts jobs, completes work, receives payment |
| **Arbiter** | A trusted third party | Only acts if there is a dispute — splits funds fairly |

### The Job Lifecycle

```
Client posts job + locks ETH
          ↓
    State: OPEN
          ↓
Freelancer accepts job
          ↓
  State: IN_PROGRESS
          ↓
    ┌─────┴──────┐
    │            │
Client       Either party
approves     raises dispute
milestone         │
    │        State: IN_DISPUTE
    │             │
ETH paid    Arbiter resolves
to          + splits ETH
freelancer        │
    │        State: RESOLVED
    │
Final milestone?
    ├── Yes → State: COMPLETED
    └── No  → Stay IN_PROGRESS

OR: Client cancels before anyone accepts
          ↓
    State: REFUNDED (full ETH back to client)
```

### Milestone System

Instead of one lump payment, jobs are broken into milestones. For example:

- Milestone 1: Design mockup → 0.01 ETH
- Milestone 2: Frontend build → 0.02 ETH
- Milestone 3: Final delivery → 0.01 ETH

The client approves and pays each milestone individually. This protects both parties — the freelancer gets paid incrementally, and the client only pays for completed work.

---

## Project Structure

```
freelance-escrow/
│
├── contracts/
│   └── FreelanceEscrow.sol       ← The main smart contract (Solidity)
|
├── frontend/
│   └── index.html                ← Full web UI using ethers.js + MetaMask
|
├──ignition/modules
|  └── Counter.ts
|
├── scripts/
│   └── deploy.ts                 ← Deployment script for Sepolia testnet
|   └── send-op-tx.ts
│
├── test/
│   └── FreelanceEscrow.ts        ← 33 Hardhat tests
│
├── types/ether-contracts
|   └── factories
|       └── FreelanceEscrop_factory.ts
|       └── index.ts
|   └── FreelanceEscrow.ts
|   └── common.ts
|   └── hardhat.ts
|   └── index.ts
│
├── hardhat.config.ts             ← Hardhat configuration (Sepolia network)
├── .env                          ← Private keys (never committed to GitHub)
├── .gitignore                    ← Protects .env from being pushed
└── package.json                  ← Node.js dependencies
└── README.md
```

---

## Smart Contract Deep Dive

### The State Machine

The heart of the contract is an **enum** (a list of named states). Every job is always in exactly one state at a time. Functions check the current state before doing anything — this prevents bugs like approving a job that was already cancelled.

```solidity
enum JobState { 
    OPEN,         // 0 - Job posted, waiting for freelancer
    IN_PROGRESS,  // 1 - Freelancer assigned, work underway
    COMPLETED,    // 2 - All milestones paid out
    IN_DISPUTE,   // 3 - Frozen, waiting for arbiter
    RESOLVED,     // 4 - Arbiter split the funds
    REFUNDED      // 5 - Client cancelled before anyone accepted
}
```

### The Job Structure

Every job is stored as a `struct` — think of it like a row in a database table. The `mapping` connects each job ID number to its struct.

```solidity
struct Job {
    uint256 id;                    // Unique job number (1, 2, 3...)
    address payable client;        // Wallet that posted the job
    address payable freelancer;    // Wallet that accepted the job
    address arbiter;               // Trusted wallet for disputes
    uint256[] milestonePayments;   // Array of ETH amounts per milestone
    uint256 completedMilestones;   // How many milestones have been paid
    uint256 originalMilestones;    // Original scope (for concludeJob)
    uint256 escrowBalance;         // How much ETH is currently locked
    JobState state;                // Current state from the enum above
}

uint256 public jobCounter;              // Increments with every new job
mapping(uint256 => Job) public jobs;    // jobId => Job data
```

### The Modifiers

Modifiers are reusable checks that run before a function executes. They keep the code clean by avoiding repeated `require` statements.

```solidity
// Checks that the caller is the client of a specific job
modifier onlyClient(uint256 _jobId) {
    require(msg.sender == jobs[_jobId].client, "Only client");
    _;  // The _ means "run the rest of the function here"
}

// Checks that the job is in a specific state
modifier inState(uint256 _jobId, JobState _state) {
    require(jobs[_jobId].state == _state, "Invalid job state");
    _;
}
```

### The Functions Explained

#### `createJob()` — Client posts a job

```solidity
function createJob(
    address _arbiter,
    uint256[] calldata _milestoneAmounts
) external payable
```

- `payable` means this function accepts ETH
- The client passes an array of milestone amounts like `[0.01 ether, 0.02 ether]`
- The contract verifies that `msg.value` (ETH sent) exactly equals the sum of all milestones
- If someone sends 0.04 ETH but milestones only add up to 0.03, it reverts — no rounding errors
- The ETH is now locked inside the contract — nobody can touch it until a valid state transition

```solidity
uint256 expectedTotal = 0;
for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
    require(_milestoneAmounts[i] > 0, "Each milestone must be > 0");
    expectedTotal += _milestoneAmounts[i];
}
require(msg.value == expectedTotal, "Deposit must match total milestones");
```

#### `acceptJob()` — Freelancer accepts the job

```solidity
function acceptJob(uint256 _jobId) external inState(_jobId, JobState.OPEN)
```

- The `inState` modifier ensures the job is still OPEN (not already taken)
- Prevents the client and arbiter from accepting their own job
- Sets the freelancer address and changes state to IN_PROGRESS

#### `approveMilestone()` — Client pays out a milestone

```solidity
function approveMilestone(uint256 _jobId) 
    external nonReentrant onlyClient(_jobId) inState(_jobId, JobState.IN_PROGRESS)
```

- `nonReentrant` (from OpenZeppelin) prevents a known attack where a malicious contract tries to call this function multiple times before the first call finishes
- Uses an index (`completedMilestones`) to know which milestone to pay next
- If all milestones are done, state changes to COMPLETED automatically

```solidity
uint256 payout = job.milestonePayments[job.completedMilestones];
job.completedMilestones++;
job.escrowBalance -= payout;

// Send ETH to freelancer using low-level call (safer than transfer)
(bool success, ) = job.freelancer.call{value: payout}("");
require(success, "Transfer failed");
```

#### `addMilestone()` — Client expands scope mid-project

```solidity
function addMilestone(uint256 _jobId) external payable onlyClient(_jobId) inState(_jobId, JobState.IN_PROGRESS)
```

- Client sends more ETH with this transaction
- A new milestone gets added to the array
- Freelancer can choose to do it or use `concludeJob()` to walk away after finishing original scope

#### `concludeJob()` — Freelancer exits after original scope

```solidity
function concludeJob(uint256 _jobId) external nonReentrant inState(_jobId, JobState.IN_PROGRESS)
```

- Only callable after `completedMilestones >= originalMilestones`
- Any leftover ETH from newly added milestones is refunded to the client
- Protects freelancers from being trapped in an ever-expanding project

#### `raiseDispute()` — Freezes the contract

```solidity
function raiseDispute(uint256 _jobId) external inState(_jobId, JobState.IN_PROGRESS)
```

- Either the client or freelancer can call this
- State immediately changes to IN_DISPUTE — nobody else can do anything
- Can only be called once — once disputed, it stays disputed until arbiter resolves it

#### `resolveDispute()` — Arbiter splits the funds

```solidity
function resolveDispute(
    uint256 _jobId,
    uint256 clientAmount,
    uint256 freelancerAmount
) external nonReentrant inState(_jobId, JobState.IN_DISPUTE)
```

- Only callable by the specific arbiter address set when the job was created
- Security check: `clientAmount + freelancerAmount` must equal exactly `escrowBalance`
- This prevents the arbiter from sending more than what is locked, or stealing funds

```solidity
require(
    clientAmount + freelancerAmount == job.escrowBalance,
    "Amounts must equal remaining balance"
);
```

#### `tipFreelancer()` — Send a bonus

```solidity
function tipFreelancer(uint256 _jobId) external payable nonReentrant
```

- Anyone can tip the freelancer on an active or completed job
- ETH bypasses the escrow entirely — goes straight to the freelancer's wallet
- Does not affect the escrow balance or job state

### The Events

Events are logs that get stored on the blockchain permanently. They are how the frontend knows what happened.

```solidity
event JobCreated(uint256 indexed jobId, address indexed client, uint256 totalAmount, uint256 milestones);
event JobCancelled(uint256 indexed jobId);
event WorkStarted(uint256 indexed jobId, address indexed freelancer);
event MilestoneApproved(uint256 indexed jobId, uint256 milestoneNumber, uint256 amountReleased);
event MilestoneAdded(uint256 indexed jobId, uint256 amountAdded, uint256 newTotalMilestones);
event JobConcludedEarly(uint256 indexed jobId, uint256 amountRefundedToClient);
event TipSent(uint256 indexed jobId, address indexed sender, uint256 amount);
event DisputeRaised(uint256 indexed jobId, address indexed raisedBy);
event DisputeResolved(uint256 indexed jobId, uint256 clientAmount, uint256 freelancerAmount);
```

The `indexed` keyword makes events searchable — you can filter all `JobCreated` events by a specific client address.

---

## Setup & Installation

### Prerequisites

- Node.js v22 LTS — download from [nodejs.org](https://nodejs.org) (choose the LTS version)
- MetaMask browser extension — [metamask.io](https://metamask.io)
- A free Alchemy account — [alchemy.com](https://alchemy.com)

### Step 1 — Clone the repo

```bash
git clone https://github.com/YOURUSERNAME/Blockchain-Freelance-Escrow.git
cd Blockchain-Freelance-Escrow
```

### Step 2 — Install dependencies

```bash
npm install
npm install --save-dev @nomicfoundation/hardhat-toolbox-mocha-ethers
```

### Step 3 — Create your `.env` file

Create a file called `.env` in the root folder:

```
PRIVATE_KEY=your_metamask_private_key_here
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_alchemy_key_here
```

**How to get your MetaMask private key:**
1. Open MetaMask
2. Click the three dots next to your account name
3. Click Account Details → Show private key
4. Type your password and copy the key

**How to get your Alchemy RPC URL:**
1. Go to [alchemy.com](https://alchemy.com) and create a free account
2. Create a new app → Choose Ethereum → Sepolia
3. Click API Key and copy the HTTPS URL

> ⚠️ Never share your private key or push your `.env` file to GitHub. It is already in `.gitignore`.

### Step 4 — Get free Sepolia ETH

1. Go to [Google's Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
2. Sign in with your Google account
3. Paste your MetaMask wallet address
4. Request ETH — arrives in 2-3 minutes

### Step 5 — Compile the contract

```bash
npx hardhat compile
```

You should see: `Compiled 1 Solidity file successfully`

---

## Running the Tests

```bash
npx hardhat test
```

You should see **33 tests passing**:

```
FreelanceEscrow
  Deployment
    ✔ Should start with a jobCounter of 0
  Job Creation
    ✔ Should create a job successfully
    ✔ Should revert if math doesn't match milestones
    ✔ Should revert if client tries to be the arbiter
    ✔ Should revert if milestone array is empty
    ✔ Should revert if arbiter is the zero address
    ✔ Should revert if any milestone amount is zero
  Job Cancellation
    ✔ Should let the client cancel an open job and refund them
    ✔ Should revert if an attacker tries to cancel
    ✔ Should revert if job is already IN_PROGRESS
  Job Acceptance
    ✔ Should let a freelancer accept an open job
    ✔ Should prevent the client from accepting their own job
    ✔ Should revert if the arbiter tries to accept the job
    ✔ Should revert if the job is already IN_PROGRESS
  Milestones and Scope
    ✔ Should let client approve a milestone and pay freelancer
    ✔ Should mark job COMPLETED after final milestone approved
    ✔ Should revert if an attacker tries to approve a milestone
    ✔ Should revert if client tries to approve when all milestones are done
    ✔ Should let client add a new milestone mid-job
    ✔ Should revert if client adds a milestone but sends 0 ETH
    ✔ Should let freelancer conclude early after original scope is done
    ✔ Should revert if freelancer tries to conclude before original scope is done
  Tipping
    ✔ Should send tips directly to the freelancer
    ✔ Should revert if tip is 0
    ✔ Should revert if tipping before a freelancer is assigned
  Disputes
    ✔ Should allow client to raise a dispute
    ✔ Should allow freelancer to raise a dispute
    ✔ Should revert if an attacker tries to raise a dispute
    ✔ Should let arbiter split funds 50/50
    ✔ Should let arbiter give 100% to client
    ✔ Should let arbiter give 100% to freelancer
    ✔ Should revert if anyone other than arbiter tries to resolve
    ✔ Should reject bad math from the arbiter

33 passing
```

### How the tests work

The tests use Hardhat's built-in local blockchain. Every test gets a fresh deployment of the contract so tests never interfere with each other.

```typescript
// Hardhat gives us 20 fake wallets with 10,000 fake ETH each
[deployer, client, freelancer, arbiter, attacker] = await eth.getSigners();

// Deploy a fresh contract before every single test
const Escrow = await eth.getContractFactory("FreelanceEscrow");
escrow = await Escrow.deploy();
```

Tests are organized into three categories:

**Happy path tests** — does the normal flow work?
```typescript
it("Should let client approve a milestone and pay freelancer", async function () {
  await expect(escrow.connect(client).approveMilestone(1n))
    .to.emit(escrow, "MilestoneApproved")
    .withArgs(1n, 1n, ONE_ETH);
});
```

**Security tests** — can attackers break things?
```typescript
it("Should revert if an attacker tries to approve a milestone", async function () {
  await expect(
    escrow.connect(attacker).approveMilestone(1n)
  ).to.be.revertedWith("Only client");
});
```

**Math/edge case tests** — do edge cases fail gracefully?
```typescript
it("Should reject bad math from the arbiter", async function () {
  await expect(
    escrow.connect(arbiter).resolveDispute(1n, TWO_ETH, ONE_ETH)
  ).to.be.revertedWith("Amounts must equal remaining balance");
});
```

---

## Deploying to Sepolia

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

Output:
```
Deploying FreelanceEscrow...
Deploying with wallet: 0x38e002...
Wallet balance: 0.149 ETH
Transaction hash: 0xabc123...
FreelanceEscrow deployed to: 0x5b4e28...
Etherscan: https://sepolia.etherscan.io/address/0x5b4e28...
```

Save the contract address and transaction hash.

### How the deploy script works

```typescript
// Connect to Sepolia network using our Alchemy URL
const connection = await hre.network.connect();
const ethers = connection.ethers;

// Use our MetaMask wallet (from .env) to sign and pay for the deployment
const [deployer] = await ethers.getSigners();

// Deploy the contract — this sends a transaction to Sepolia
const FreelanceEscrow = await ethers.getContractFactory("FreelanceEscrow");
const contract = await FreelanceEscrow.deploy();

// Wait for the transaction to be mined (included in a block)
await contract.waitForDeployment();
```

---

## Using the Frontend

### For users — no setup needed

1. Go to the GitHub Pages URL
2. Make sure MetaMask is installed and switched to **Sepolia Test Network**
3. Get free Sepolia ETH from [Google's faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
4. Click **Connect Wallet**

### Full demo flow

**Posting a job (Client):**
1. Enter the arbiter's wallet address
2. Enter milestone amounts separated by commas e.g. `0.01, 0.02`
3. Click **Post Job & Lock ETH**
4. Confirm the transaction in MetaMask
5. The job appears in the dashboard as **OPEN**

**Accepting a job (Freelancer):**
1. Open the same URL with a different MetaMask wallet
2. See the OPEN job in the dashboard
3. Click **Accept Job** and confirm
4. Job status changes to **IN PROGRESS**

**Approving milestones (Client):**
1. Click **Approve Milestone** when work is done
2. ETH is automatically sent to the freelancer's wallet
3. Milestone shows as **Paid** in the dashboard
4. After the last milestone, job becomes **COMPLETED**

**Raising a dispute:**
1. Either client or freelancer clicks **Raise Dispute**
2. Job freezes at **IN DISPUTE**
3. The arbiter sees resolve inputs appear on their screen
4. Arbiter enters client share and freelancer share (must add up to escrow balance)
5. Clicks **Resolve** — ETH splits automatically

**Tipping a freelancer:**
1. Enter an amount in the tip box on any active job
2. Click **Tip** — ETH goes directly to the freelancer instantly

### How the frontend connects to the contract

The frontend uses **ethers.js** — a JavaScript library that lets a webpage talk to the blockchain through MetaMask.

```javascript
// Connect to the user's MetaMask wallet
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

// Create a reference to our deployed contract
// ABI tells ethers.js what functions the contract has
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// Call a contract function — MetaMask pops up for confirmation
const tx = await contract.createJob(arbiterAddress, milestones, { value: totalETH });
await tx.wait(); // Wait for transaction to be mined
```

---

## Test Plan

Before writing any test code, we mapped out every scenario that needed testing:

### 1. Deployment
- Job counter starts at 0

### 2. Job Creation
- Successfully creates job with correct ETH
- Reverts if ETH doesn't match milestone sum
- Reverts if client sets themselves as arbiter
- Reverts if milestone array is empty
- Reverts if arbiter is zero address
- Reverts if any milestone amount is zero

### 3. Job Cancellation
- Client gets full refund when cancelling OPEN job
- Attacker cannot cancel
- Cannot cancel IN_PROGRESS job

### 4. Job Acceptance
- Freelancer successfully accepts OPEN job
- Client cannot accept own job
- Arbiter cannot accept job
- Cannot accept already IN_PROGRESS job

### 5. Milestone Execution
- Client approves milestone, freelancer gets ETH
- Final milestone approval marks job COMPLETED
- Attacker cannot approve milestones
- Cannot approve when all milestones done

### 6. Scope Management
- Client can add milestone with extra ETH
- Cannot add milestone with 0 ETH
- Freelancer can conclude after original scope complete
- Cannot conclude before original scope done

### 7. Tipping
- Tip goes directly to freelancer
- Cannot tip 0 ETH
- Cannot tip job with no freelancer assigned

### 8. Dispute Resolution
- Client can raise dispute
- Freelancer can raise dispute
- Attacker cannot raise dispute
- Arbiter can split 50/50
- Arbiter can give 100% to either party
- Non-arbiter cannot resolve
- Arbiter math must equal escrow balance

---

## Design Decisions

### Why a state machine?

We used an enum with 6 states instead of boolean flags. This makes illegal transitions physically impossible. For example, you cannot approve a milestone on a REFUNDED job because the `inState` modifier rejects it before any code runs. No amount of clever attacking can bypass this.

### Why per-job arbiters instead of one global arbiter?

Each job can have a different arbiter. This means:
- Clients can choose someone they trust for their specific job
- No single point of failure — if one arbiter goes rogue, only their jobs are affected
- In a production system, this arbiter role would be replaced by a DAO

### Why track `escrowBalance` separately?

Instead of calling `address(this).balance`, we track `escrowBalance` per job. This means multiple jobs can exist simultaneously without their ETH getting mixed up.

### Why use `.call{value: amount}("")` instead of `.transfer()`?

`.transfer()` forwards only 2300 gas which can fail if the recipient is a smart contract. `.call` forwards all available gas and is the recommended pattern since the Istanbul hard fork. We pair it with `nonReentrant` to prevent reentrancy attacks.

### Why `originalMilestones`?

When a client adds new milestones mid-project, we need to track the original agreed scope separately. Otherwise a client could add 100 milestones after the fact and the freelancer would be trapped. `concludeJob` lets the freelancer exit cleanly after their original commitment.

---

## Extra Credit Features

| Feature | Points | Implementation |
|---|---|---|
| OpenZeppelin Integration | +1 pt | `ReentrancyGuard` imported and used on all ETH-transferring functions |
| Frontend | +6 pts | Full dashboard with `index.html` + ethers.js + MetaMask |
| Advanced Testing | +1 pt | 33 tests covering happy paths, security attacks, and math edge cases |

---

## Team

| Name | Role | Contribution |
|---|---|---|
| Nishant & Akshat | Smart Contract | Wrote `FreelanceEscrow.sol` |
| Akshat | Testing | Wrote all 33 Hardhat tests |
| Nishant & Kevin | Deployment + Frontend | Deploy script, Sepolia deployment, `index.html` |

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Solidity 0.8.28 | Smart contract language |
| Hardhat v3 | Development environment and testing framework |
| ethers.js v6 | JavaScript library for blockchain interaction |
| OpenZeppelin | Security library (`ReentrancyGuard`) |
| Mocha + Chai | Test runner and assertion library |
| Alchemy | Sepolia RPC endpoint |
| MetaMask | Browser wallet for signing transactions |

---

## License

MIT
