# FreelanceEscrow — Decentralized Freelance Payment System

> A trustless escrow smart contract built on Ethereum that replaces middlemen like Upwork or Fiverr. Clients lock ETH on-chain, freelancers complete milestones to earn payment, and a trusted arbiter resolves disputes — all without a central authority.

**Live Demo:** [GitHub Pages URL]

**Contract on Sepolia:** `0x5b4e2819cF58DD50809a8eE904618e5227F76B0E`

**Etherscan:** https://sepolia.etherscan.io/address/0x5b4e2819cF58DD50809a8eE904618e5227F76B0E

**Transaction Hash:** `0x38e002E37ff6bE9c14F160007F4a8c1FC2412dDd`

---

## What Problem Does This Solve?

Traditional freelance platforms like Upwork and Fiverr have serious problems:

- They take **10–20% fees** on every transaction
- They can **freeze your account** or reverse payments arbitrarily
- You have to **trust a company** to hold your money and resolve disputes fairly
- Payments can take **days to clear**

Our smart contract solves all of this. Once deployed, the rules are coded on-chain and **nobody can change them** — not us, not anyone. ETH is locked in the contract itself and only moves when the coded conditions are met.

---

## How It Works

### The Three Actors

| Role | Who They Are | What They Do |
|---|---|---|
| **Client** | The person hiring | Posts the job, locks ETH, approves milestones |
| **Freelancer** | The person working | Accepts jobs, completes work, receives payment per milestone |
| **Arbiter** | A trusted third party | Only acts if there is a dispute — splits funds fairly |

### The Job Lifecycle

```
          Client posts job + locks ETH
                    ↓
              State: OPEN
                    ↓
          Freelancer accepts job
                    ↓
┌─- - - - - -State: IN_PROGRESS
│                   ↓
│             ┌─────┴──────┐
│             │            │
│         Client       Either party
│         approves     raises dispute
│         milestone         │
│             │        State: IN_DISPUTE
│             │             │
│         ETH paid    Arbiter resolves
│           to          + splits ETH
│         freelancer        │
│             │        State: RESOLVED
│             │
│         Final milestone?
└─ - - - - -  ├── No  → Stay IN_PROGRESS  
              └── Yes → State: COMPLETED

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

### Scope Expansion

Mid-project, the client can add new milestones with additional ETH. The freelancer can choose to complete them or use `concludeJob()` to exit cleanly after finishing their original commitment. Any unearned ETH from added milestones is automatically refunded to the client.

---

## Project Structure

```
freelance-escrow/
│
├── contracts/
│   └── FreelanceEscrow.sol       ← The main smart contract (Solidity)
│
├── frontend/
│   └── index.html                ← Full web UI using ethers.js + MetaMask
│
├── scripts/
│   └── deploy.ts                 ← Deployment script for Sepolia testnet
│
├── test/
│   └── FreelanceEscrow.ts        ← 33 Hardhat tests
│
├── hardhat.config.ts             ← Hardhat configuration (Sepolia network)
├── .env                          ← Private keys (never committed to GitHub)
├── .gitignore                    ← Protects .env from being pushed
└── package.json                  ← Node.js dependencies
```

---

## Smart Contract Deep Dive

### The State Machine

The heart of the contract is an **enum** (a list of named states). Every job is always in exactly one state at a time. Functions check the current state before doing anything — this prevents bugs like approving a job that was already cancelled or a freelancer accepting a job that is already in progress.

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

### The Job Struct

Every job is stored as a struct containing the attributes shown below. The `mapping` connects each job ID number to its struct so we can look up any job instantly by its ID.

```solidity
struct Job {
    uint256 id;                    // Job number, unique to each jon
    address payable client;        // Wallet that posted the job
    address payable freelancer;    // Wallet that accepted the job
    address arbiter;               // Trusted wallet to resolve disputes
    uint256[] milestonePayments;   // Array of ETH amounts per milestone e.g. [1 ETH, 2 ETH]
    uint256 completedMilestones;   // How many milestones have been paid out so far
    uint256 originalMilestones;    // Original agreed scope (used by concludeJob)
    uint256 bufferBalance;         // How much ETH is currently locked in this job
    JobState state;                // Current state from the enum above
}

uint256 public jobCounter;              // Increments with every new job (1, 2, 3...)
mapping(uint256 => Job) public jobs;    // jobId => Job data
```

### The Modifiers

Modifiers are reusable checks that run **before** a function executes. They keep the code clean by avoiding copy-pasting the same `require` statements in every function.

```solidity
// Checks that the caller is the client of a specific job
modifier onlyClient(uint256 _jobId) {
    require(msg.sender == jobs[_jobId].client, "Only client");
    _;  // The underscore means "now run the actual function body"
}

// Checks that the job is currently in a specific state
modifier inState(uint256 _jobId, JobState _state) {
    require(jobs[_jobId].state == _state, "Invalid job state");
    _;
}
```

For example, `approveMilestone` uses both modifiers at once:

```solidity
function approveMilestone(uint256 _jobId)
    external
    nonReentrant
    onlyClient(_jobId)                             // Must be the client
    inState(_jobId, JobState.IN_PROGRESS)          // Job must be in progress
```

If either check fails, the transaction reverts immediately and no ETH moves.

---

### The Functions Explained

#### `createJob()` — Client posts a job

```solidity
function createJob(
    address _arbiter,
    uint256[] calldata _milestoneAmounts
) external payable
```

- `payable` means this function accepts ETH alongside the call
- The client passes an array of milestone amounts e.g. `[1 ether, 2 ether]`
- The contract loops through the array and sums up all the amounts
- It then requires that `msg.value` (the ETH actually sent) equals exactly that sum — no rounding, no approximations
- If someone sends too much or too little the transaction reverts and their ETH is returned automatically
- Once accepted, the ETH is locked inside the contract — nobody can touch it until a valid state transition

```solidity
uint256 expectedTotal = 0;
for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
    require(_milestoneAmounts[i] > 0, "Each milestone must be > 0");
    expectedTotal += _milestoneAmounts[i];
}
require(msg.value == expectedTotal, "Deposit must match total milestones");
```

---

#### `cancelJob()` — Client cancels before anyone accepts

```solidity
function cancelJob(uint256 _jobId)
    external
    nonReentrant
    onlyClient(_jobId)
    inState(_jobId, JobState.OPEN)
```

- Only callable when the job is still `OPEN` — once a freelancer has accepted, cancellation is blocked
- The full `bufferBalance` is refunded back to the client automatically
- State changes to `REFUNDED`
- We set `bufferBalance = 0` before sending ETH — this is the checks-effects-interactions security pattern

```solidity
job.state = JobState.REFUNDED;
uint256 amount = job.bufferBalance;
job.bufferBalance = 0;          // Zero out before sending — prevents reentrancy

(bool success, ) = job.client.call{value: amount}("");
require(success, "Refund failed");
```

---

#### `acceptJob()` — Freelancer accepts the job

```solidity
function acceptJob(uint256 _jobId)
    external
    inState(_jobId, JobState.OPEN)
```

- The `inState` modifier ensures the job is still `OPEN` — prevents two freelancers racing to accept the same job
- Explicitly blocks the client and arbiter from accepting their own job
- Sets the `freelancer` address on the job struct
- Changes state to `IN_PROGRESS`

```solidity
require(msg.sender != job.client, "Client cannot be freelancer");
require(msg.sender != job.arbiter, "Arbiter cannot be freelancer");

job.freelancer = payable(msg.sender);
job.state = JobState.IN_PROGRESS;
```

---

#### `approveMilestone()` — Client pays out a completed milestone

```solidity
function approveMilestone(uint256 _jobId)
    external
    nonReentrant
    onlyClient(_jobId)
    inState(_jobId, JobState.IN_PROGRESS)
```

- `nonReentrant` (from OpenZeppelin) prevents a reentrancy attack — where a malicious contract tries to call this function multiple times before the first call finishes, potentially draining the escrow
- Uses `completedMilestones` as an index to know which milestone to pay next — always pays in order
- Deducts the payout from `bufferBalance` first, then sends ETH (safe pattern)
- If all milestones are paid out, state automatically changes to `COMPLETED`

```solidity
uint256 payout = job.milestonePayments[job.completedMilestones];
job.completedMilestones++;
job.bufferBalance -= payout;

// Mark job complete if all milestones are done
if (job.completedMilestones == job.milestonePayments.length) {
    job.state = JobState.COMPLETED;
}

// Send ETH using low-level call (safer than .transfer())
(bool success, ) = job.freelancer.call{value: payout}("");
require(success, "Transfer failed");
```

---

#### `addMilestone()` — Client expands scope mid-project

```solidity
function addMilestone(uint256 _jobId)
    external
    payable
    onlyClient(_jobId)
    inState(_jobId, JobState.IN_PROGRESS)
```

- Client sends additional ETH with this transaction to fund the new milestone
- The new milestone amount gets pushed onto the `milestonePayments` array
- `bufferBalance` increases by the new amount
- The freelancer can choose to do this new milestone or use `concludeJob()` to walk away

```solidity
require(msg.value > 0, "Must fund the new milestone");
job.milestonePayments.push(msg.value);
job.bufferBalance += msg.value;
```

---

#### `concludeJob()` — Freelancer exits cleanly after original scope

```solidity
function concludeJob(uint256 _jobId)
    external
    nonReentrant
    inState(_jobId, JobState.IN_PROGRESS)
```

- Callable by either the client or freelancer once the original agreed milestones are all completed
- Checks `completedMilestones >= originalMilestones` — cannot be called until the original scope is finished
- Any leftover ETH in `bufferBalance` from newly added milestones is refunded to the client
- Protects freelancers from being trapped in an ever-expanding project with no exit

```solidity
require(
    msg.sender == job.freelancer || msg.sender == job.client,
    "Not authorized"
);
require(
    job.completedMilestones >= job.originalMilestones,
    "Original scope not yet complete"
);

job.state = JobState.COMPLETED;
uint256 refundAmount = job.bufferBalance;
job.bufferBalance = 0;

if (refundAmount > 0) {
    (bool success, ) = job.client.call{value: refundAmount}("");
    require(success, "Refund failed");
}
```

---

#### `raiseDispute()` — Freezes the contract

```solidity
function raiseDispute(uint256 _jobId)
    external
    inState(_jobId, JobState.IN_PROGRESS)
```

- Either the client **or** the freelancer can call this — whoever feels the other party is not holding up their end
- State immediately changes to `IN_DISPUTE` — the contract is now completely frozen
- Nobody except the arbiter can do anything to this job anymore
- Can only be raised once — the `inState` modifier blocks any further calls once disputed

```solidity
require(
    msg.sender == job.client || msg.sender == job.freelancer,
    "Only client or freelancer"
);
job.state = JobState.IN_DISPUTE;
```

---

#### `resolveDispute()` — Arbiter splits the locked funds

```solidity
function resolveDispute(
    uint256 _jobId,
    uint256 clientAmount,
    uint256 freelancerAmount
) external nonReentrant inState(_jobId, JobState.IN_DISPUTE)
```

- Only callable by the specific arbiter address that was set when the job was created
- The arbiter passes two amounts — how much to send to each party
- Critical security check: both amounts must add up to exactly `bufferBalance` — prevents the arbiter from stealing funds or distributing more than what is locked
- The arbiter can do any split: 50/50, 100% to client, 100% to freelancer, or any custom ratio

```solidity
require(msg.sender == job.arbiter, "Only arbiter");
require(
    clientAmount + freelancerAmount == job.bufferBalance,
    "Amounts must equal remaining balance"
);

job.state = JobState.RESOLVED;
job.bufferBalance = 0;

if (clientAmount > 0) {
    (bool success, ) = job.client.call{value: clientAmount}("");
    require(success, "Client transfer failed");
}
if (freelancerAmount > 0) {
    (bool success, ) = job.freelancer.call{value: freelancerAmount}("");
    require(success, "Freelancer transfer failed");
}
```

---

#### `tipFreelancer()` — Send a bonus tip

```solidity
function tipFreelancer(uint256 _jobId)
    external
    payable
    nonReentrant
```

- Anyone can send a tip — not just the client
- The tip bypasses the escrow entirely and goes straight to the freelancer's wallet instantly
- Does not affect `bufferBalance` or job state in any way
- Requires a freelancer to be assigned and the job to be active

```solidity
require(msg.value > 0, "Tip must be > 0");
require(job.freelancer != address(0), "No freelancer assigned yet");

(bool success, ) = job.freelancer.call{value: msg.value}("");
require(success, "Tip failed");
```

---

### The View Functions

These functions are free to call — they read data from the blockchain without writing anything and cost no gas.

```solidity
// Returns the full array of milestone amounts for a job
function getMilestones(uint256 _jobId) external view returns (uint256[] memory)

// Returns how much ETH is currently locked in a job
function getBufferBalance(uint256 _jobId) external view returns (uint256)
```

These are used by the frontend to display milestone progress and locked balance without needing to decode the full job struct.

---

### The Events

Events are logs stored on the blockchain permanently. They cannot be changed or deleted. They are how the frontend knows what happened — ethers.js listens for these events and updates the UI.

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

The `indexed` keyword makes events searchable on Etherscan and via ethers.js — for example you can filter all `JobCreated` events by a specific client address to find every job posted by that wallet.

---

## Setup & Installation

### Prerequisites

- Node.js v22 LTS — download from [nodejs.org](https://nodejs.org) (choose the LTS version)
- MetaMask browser extension — [metamask.io](https://metamask.io)
- A free Alchemy account — [alchemy.com](https://alchemy.com)

### Step 1 — Clone the repo

```bash
git clone https://github.com/YOURUSERNAME/freelance-escrow.git
cd freelance-escrow
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

  const job = await escrow.jobs(1n);
  expect(job.bufferBalance).to.equal(ONE_ETH); // Balance reduced by one milestone
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

**Math and edge case tests** — do bad inputs fail gracefully?
```typescript
it("Should reject bad math from the arbiter", async function () {
  await expect(
    escrow.connect(arbiter).resolveDispute(1n, TWO_ETH, ONE_ETH) // 3 ETH total, only 2 locked
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

Save the contract address and transaction hash — you need both for submission.

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
4. Arbiter enters client share and freelancer share — must add up to exactly the buffer balance
5. Clicks **Resolve** — ETH splits automatically

**Tipping a freelancer:**
1. Enter an ETH amount in the tip box on any active job
2. Click **Tip** — ETH goes directly to the freelancer instantly

**Adding a milestone mid-project (Client):**
1. While job is IN PROGRESS, click **Add Milestone**
2. Enter the ETH amount for the new milestone
3. Confirm in MetaMask — ETH is added to the buffer

**Concluding after original scope (Freelancer):**
1. Once all original milestones are approved, click **Conclude Job**
2. Any ETH from added milestones is refunded to client
3. Job marks as COMPLETED

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

The UI automatically shows or hides buttons based on who is connected:
- **Client wallet** sees: Approve Milestone, Add Milestone, Raise Dispute, Cancel Job
- **Freelancer wallet** sees: Accept Job, Raise Dispute, Conclude Job, Tip
- **Arbiter wallet** sees: Resolve Dispute inputs (only when job is IN DISPUTE)

---

## Test Plan

Before writing any test code, we mapped out every scenario that needed testing using a plain-English master test plan. This approach is called Test-Driven Development (TDD).

---

### 1. Deployment

| Test | Type | What It Checks |
|---|---|---|
| Job counter starts at 0 | Happy path | Fresh contract has `jobCounter == 0` |

---

### 2. Job Creation (`createJob`)

| Test | Type | What It Checks |
|---|---|---|
| Successfully creates a job | Happy path | Job created, `JobCreated` event emitted, `bufferBalance` correct |
| Reverts if ETH doesn't match milestones | Math check | Sending 4 ETH for milestones totalling 3 ETH reverts |
| Reverts if client is the arbiter | Security | Same address cannot be both client and arbiter |
| Reverts if milestone array is empty | Edge case | Must have at least 1 milestone |
| Reverts if arbiter is zero address | Edge case | Prevents accidentally setting no arbiter |
| Reverts if any milestone amount is zero | Edge case | Every milestone must have a real ETH value |

```typescript
it("Should create a job successfully", async function () {
  const milestones = [ONE_ETH, TWO_ETH]; // Total = 3 ETH

  await expect(
    escrow.connect(client).createJob(arbiter.address, milestones, { value: THREE_ETH })
  ).to.emit(escrow, "JobCreated")
   .withArgs(1n, client.address, THREE_ETH, 2n);

  const job = await escrow.jobs(1n);
  expect(job.arbiter).to.equal(arbiter.address);
  expect(job.bufferBalance).to.equal(THREE_ETH);
});
```

---

### 3. Job Cancellation (`cancelJob`)

| Test | Type | What It Checks |
|---|---|---|
| Client cancels and gets full refund | Happy path | ETH returned, state becomes REFUNDED, balance becomes 0 |
| Attacker cannot cancel | Security | Only the client who posted the job can cancel |
| Cannot cancel IN_PROGRESS job | Edge case | Once a freelancer accepts, cancellation is blocked |

```typescript
it("Should let the client cancel an open job and refund them", async function () {
  const balanceBefore = await eth.provider.getBalance(client.address);
  const tx = await escrow.connect(client).cancelJob(1n);
  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed * receipt.gasPrice;
  const balanceAfter = await eth.provider.getBalance(client.address);

  const job = await escrow.jobs(1n);
  expect(job.state).to.equal(5n);            // 5 = REFUNDED
  expect(job.bufferBalance).to.equal(0n);
  expect(balanceAfter + gasUsed).to.equal(balanceBefore + ONE_ETH); // Got money back
});
```

---

### 4. Job Acceptance (`acceptJob`)

| Test | Type | What It Checks |
|---|---|---|
| Freelancer accepts open job | Happy path | State becomes IN_PROGRESS, `WorkStarted` event emitted |
| Client cannot accept own job | Security | Conflict of interest — blocked explicitly |
| Arbiter cannot accept job | Security | Conflict of interest — blocked explicitly |
| Cannot accept already IN_PROGRESS job | Edge case | Only one freelancer can ever take a job |

```typescript
it("Should let a freelancer accept an open job", async function () {
  await expect(escrow.connect(freelancer).acceptJob(1n))
    .to.emit(escrow, "WorkStarted")
    .withArgs(1n, freelancer.address);

  const job = await escrow.jobs(1n);
  expect(job.state).to.equal(1n); // 1 = IN_PROGRESS
});
```

---

### 5. Milestone Execution (`approveMilestone`)

| Test | Type | What It Checks |
|---|---|---|
| Client approves milestone, freelancer gets ETH | Happy path | ETH moves, `bufferBalance` decreases, event emitted |
| Final milestone marks job COMPLETED | Happy path | After last approval, state becomes COMPLETED automatically |
| Attacker cannot approve | Security | Only the client can release funds |
| Cannot approve when all milestones done | Edge case | `inState` modifier catches this — job is COMPLETED not IN_PROGRESS |

```typescript
it("Should mark job COMPLETED after final milestone approved", async function () {
  await escrow.connect(client).approveMilestone(1n); // Approve milestone 1
  await escrow.connect(client).approveMilestone(1n); // Approve milestone 2 (final)

  const job = await escrow.jobs(1n);
  expect(job.state).to.equal(2n);          // 2 = COMPLETED
  expect(job.bufferBalance).to.equal(0n);  // All ETH paid out
});
```

---

### 6. Scope Management (`addMilestone` and `concludeJob`)

| Test | Type | What It Checks |
|---|---|---|
| Client adds milestone mid-job | Happy path | Buffer increases, new milestone added to array, event emitted |
| Cannot add milestone with 0 ETH | Edge case | Must actually fund the new milestone |
| Freelancer concludes after original scope | Happy path | Remaining ETH from added milestones refunded to client |
| Cannot conclude before original scope done | Edge case | Must finish what you originally agreed to |

```typescript
it("Should let freelancer conclude early after original scope is done", async function () {
  // Client adds an extra milestone that freelancer doesn't want to do
  await escrow.connect(client).addMilestone(1n, { value: TWO_ETH });

  // Freelancer completes original 2 milestones
  await escrow.connect(client).approveMilestone(1n);
  await escrow.connect(client).approveMilestone(1n);

  // Freelancer walks away — TWO_ETH from the extra milestone goes back to client
  await expect(escrow.connect(freelancer).concludeJob(1n))
    .to.emit(escrow, "JobConcludedEarly")
    .withArgs(1n, TWO_ETH);
});
```

---

### 7. Tipping (`tipFreelancer`)

| Test | Type | What It Checks |
|---|---|---|
| Tip goes directly to freelancer | Happy path | ETH bypasses escrow, goes straight to freelancer wallet |
| Cannot tip 0 ETH | Edge case | Must send a real amount |
| Cannot tip job with no freelancer assigned | Edge case | No address to send to — reverts |

```typescript
it("Should send tips directly to the freelancer", async function () {
  await escrow.connect(freelancer).acceptJob(1n);

  const balanceBefore = await eth.provider.getBalance(freelancer.address);
  await escrow.connect(attacker).tipFreelancer(1n, { value: ONE_ETH }); // Anyone can tip
  const balanceAfter = await eth.provider.getBalance(freelancer.address);

  expect(balanceAfter).to.equal(balanceBefore + ONE_ETH); // Full tip received instantly
});
```

---

### 8. Dispute Resolution (`raiseDispute` and `resolveDispute`)

| Test | Type | What It Checks |
|---|---|---|
| Client can raise dispute | Happy path | State becomes IN_DISPUTE, `DisputeRaised` event emitted |
| Freelancer can raise dispute | Happy path | Either party can freeze the contract |
| Attacker cannot raise dispute | Security | Only parties involved in the job can dispute |
| Arbiter splits 50/50 | Happy path | Both parties receive correct amounts, state becomes RESOLVED |
| Arbiter gives 100% to client | Happy path | Full refund scenario — freelancer did no work |
| Arbiter gives 100% to freelancer | Happy path | Full payment scenario — client is being unreasonable |
| Non-arbiter cannot resolve | Security | Only the specific arbiter address set at job creation can resolve |
| Arbiter math must equal buffer balance | Math check | Cannot distribute more or less than what is locked |

```typescript
it("Should let arbiter split funds 50/50", async function () {
  await escrow.connect(client).raiseDispute(1n);

  // Split 2 ETH equally — 1 ETH to each party
  await expect(escrow.connect(arbiter).resolveDispute(1n, ONE_ETH, ONE_ETH))
    .to.emit(escrow, "DisputeResolved")
    .withArgs(1n, ONE_ETH, ONE_ETH);

  const job = await escrow.jobs(1n);
  expect(job.state).to.equal(4n);          // 4 = RESOLVED
  expect(job.bufferBalance).to.equal(0n);  // All ETH distributed
});

it("Should reject bad math from the arbiter", async function () {
  await escrow.connect(freelancer).raiseDispute(1n);

  // Arbiter tries to send 3 ETH total when only 2 ETH is locked
  await expect(
    escrow.connect(arbiter).resolveDispute(1n, TWO_ETH, ONE_ETH)
  ).to.be.revertedWith("Amounts must equal remaining balance");
});
```

---

## Design Decisions

### Why a state machine?

We used an enum with 6 states instead of boolean flags. This makes illegal transitions physically impossible. For example, you cannot approve a milestone on a REFUNDED job because the `inState` modifier rejects it before any code runs. No amount of clever attacking can bypass this.

### Why per-job arbiters instead of one global arbiter?

Each job can have a different arbiter. This means clients can choose someone they trust for their specific job, and there is no single point of failure. In a production system, this arbiter role would be replaced by a DAO where token holders vote on disputes — removing the last centralized point of trust entirely.

### Why track `bufferBalance` separately?

Instead of calling `address(this).balance`, we track `bufferBalance` per job. This means multiple jobs can exist simultaneously without their ETH getting mixed up. If 10 jobs are running at once, each one knows exactly how much ETH belongs to it.

### Why use `.call{value: amount}("")` instead of `.transfer()`?

`.transfer()` only forwards 2300 gas to the recipient. If the recipient is a smart contract that needs more gas to receive ETH, the transaction silently fails. `.call` forwards all available gas and is the recommended pattern since the Istanbul hard fork in 2019. We pair it with `nonReentrant` from OpenZeppelin to prevent reentrancy attacks.

### Why `originalMilestones`?

When a client adds new milestones mid-project, we need to track the original agreed scope separately. Otherwise a client could keep adding milestones indefinitely and the freelancer would have no exit. `concludeJob` lets the freelancer exit cleanly after their original commitment, with any unearned ETH returned to the client automatically.

### Why zero out `bufferBalance` before sending ETH?

This follows the checks-effects-interactions pattern — a best practice in Solidity. By setting the balance to 0 before the external call, we prevent a scenario where a reentrant call could read a non-zero balance and attempt to drain it again. Even with `nonReentrant` as backup, the pattern is followed for defense in depth.

---

## Extra Credit Features

| Feature | Points | Implementation |
|---|---|---|
| OpenZeppelin Integration | +1 pt | `ReentrancyGuard` imported and applied to all ETH-transferring functions |
| Frontend | +6 pts | Full dashboard with `index.html` + ethers.js + MetaMask integration |
| Advanced Testing | +1 pt | 33 tests covering happy paths, security attacks, and math edge cases |

**Total extra credit: +8 points**

---

## Team

| Name | Role | Contribution |
|---|---|---|
| Nishant & Akshat | Smart Contract | Wrote `FreelanceEscrow.sol` — all functions, modifiers, events |
| Akshat | Testing | Wrote all 33 Hardhat tests across 8 test suites |
| Nishant & Kevin | Deployment + Frontend | Deploy script, Sepolia deployment, `index.html` UI |

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Solidity 0.8.28 | Smart contract language |
| Hardhat v3 | Development environment and testing framework |
| ethers.js v6 | JavaScript library for blockchain interaction |
| OpenZeppelin | Security library (`ReentrancyGuard`) |
| Mocha + Chai | Test runner and assertion library |
| Alchemy | Sepolia RPC endpoint for deployment |
| MetaMask | Browser wallet for signing transactions |
| GitHub Pages | Frontend hosting |

---

## License

MIT
