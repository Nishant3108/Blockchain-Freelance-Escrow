// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FreelanceEscrow
 * @dev A decentralized escrow system for freelancers and clients.
 *      Supports milestones, tipping, scope expansion, and dispute resolution.
 */
contract FreelanceEscrow is ReentrancyGuard {

    // -------------------------------------------------------
    // Enums & Structs
    // -------------------------------------------------------

    enum JobState { OPEN, IN_PROGRESS, COMPLETED, IN_DISPUTE, RESOLVED, REFUNDED }

    struct Job {
        uint256 id;
        address payable client;
        address payable freelancer;
        address arbiter;
        uint256[] milestonePayments;  // ETH payout per milestone
        uint256 completedMilestones;  // How many milestones paid out so far
        uint256 originalMilestones;   // Original scope — freelancer can conclude after this
        uint256 escrowBalance;        // Remaining locked funds
        JobState state;
    }

    // -------------------------------------------------------
    // State Variables
    // -------------------------------------------------------

    uint256 public jobCounter;
    mapping(uint256 => Job) public jobs;

    // -------------------------------------------------------
    // Events
    // -------------------------------------------------------

    event JobCreated(uint256 indexed jobId, address indexed client, uint256 totalAmount, uint256 milestones);
    event JobCancelled(uint256 indexed jobId);
    event WorkStarted(uint256 indexed jobId, address indexed freelancer);
    event MilestoneApproved(uint256 indexed jobId, uint256 milestoneNumber, uint256 amountReleased);
    event MilestoneAdded(uint256 indexed jobId, uint256 amountAdded, uint256 newTotalMilestones);
    event JobConcludedEarly(uint256 indexed jobId, uint256 amountRefundedToClient);
    event TipSent(uint256 indexed jobId, address indexed sender, uint256 amount);
    event DisputeRaised(uint256 indexed jobId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed jobId, uint256 clientAmount, uint256 freelancerAmount);

    // -------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------

    modifier onlyClient(uint256 _jobId) {
        require(msg.sender == jobs[_jobId].client, "Only client");
        _;
    }

    modifier inState(uint256 _jobId, JobState _state) {
        require(jobs[_jobId].state == _state, "Invalid job state");
        _;
    }

    // -------------------------------------------------------
    // Core Functions
    // -------------------------------------------------------

    /**
     * @dev Client creates a job with milestone payments and locks ETH.
     * @param _arbiter Address of the trusted arbiter for dispute resolution
     * @param _milestoneAmounts Array of ETH amounts per milestone e.g. [1 ether, 2 ether]
     */
    function createJob(
        address _arbiter,
        uint256[] calldata _milestoneAmounts
    ) external payable {
        require(_milestoneAmounts.length > 0, "Must have at least 1 milestone");
        require(_arbiter != address(0), "Invalid arbiter address");
        require(_arbiter != msg.sender, "Client cannot be arbiter");

        // Verify deposit exactly matches sum of all milestones
        uint256 expectedTotal = 0;
        for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
            require(_milestoneAmounts[i] > 0, "Each milestone must be > 0");
            expectedTotal += _milestoneAmounts[i];
        }
        require(msg.value == expectedTotal, "Deposit must match total milestones");

        jobCounter++;
        Job storage newJob = jobs[jobCounter];
        newJob.id = jobCounter;
        newJob.client = payable(msg.sender);
        newJob.freelancer = payable(address(0));
        newJob.arbiter = _arbiter;
        newJob.milestonePayments = _milestoneAmounts;
        newJob.completedMilestones = 0;
        newJob.originalMilestones = _milestoneAmounts.length;
        newJob.escrowBalance = msg.value;
        newJob.state = JobState.OPEN;

        emit JobCreated(jobCounter, msg.sender, msg.value, _milestoneAmounts.length);
    }

    /**
     * @dev Client cancels job before anyone accepts it. Full refund.
     */
    function cancelJob(uint256 _jobId)
        external
        nonReentrant
        onlyClient(_jobId)
        inState(_jobId, JobState.OPEN)
    {
        Job storage job = jobs[_jobId];

        job.state = JobState.REFUNDED;
        uint256 refund = job.escrowBalance;
        job.escrowBalance = 0;

        (bool success, ) = job.client.call{value: refund}("");
        require(success, "Refund failed");

        emit JobCancelled(_jobId);
    }

    /**
     * @dev Freelancer accepts the job and work begins.
     */
    function acceptJob(uint256 _jobId)
        external
        inState(_jobId, JobState.OPEN)
    {
        Job storage job = jobs[_jobId];
        require(msg.sender != job.client, "Client cannot be freelancer");
        require(msg.sender != job.arbiter, "Arbiter cannot be freelancer");

        job.freelancer = payable(msg.sender);
        job.state = JobState.IN_PROGRESS;

        emit WorkStarted(_jobId, msg.sender);
    }

    /**
     * @dev Client approves the current milestone and releases its payment.
     */
    function approveMilestone(uint256 _jobId)
        external
        nonReentrant
        onlyClient(_jobId)
        inState(_jobId, JobState.IN_PROGRESS)
    {
        Job storage job = jobs[_jobId];
        require(
            job.completedMilestones < job.milestonePayments.length,
            "All milestones already approved"
        );

        uint256 payout = job.milestonePayments[job.completedMilestones];
        job.completedMilestones++;
        job.escrowBalance -= payout;

        // Mark completed if all milestones are done
        if (job.completedMilestones == job.milestonePayments.length) {
            job.state = JobState.COMPLETED;
        }

        (bool success, ) = job.freelancer.call{value: payout}("");
        require(success, "Transfer failed");

        emit MilestoneApproved(_jobId, job.completedMilestones, payout);
    }

    /**
     * @dev Client adds a new milestone and funds it on top of existing escrow.
     */
    function addMilestone(uint256 _jobId)
        external
        payable
        onlyClient(_jobId)
        inState(_jobId, JobState.IN_PROGRESS)
    {
        require(msg.value > 0, "Must fund the new milestone");

        Job storage job = jobs[_jobId];
        job.milestonePayments.push(msg.value);
        job.escrowBalance += msg.value;

        emit MilestoneAdded(_jobId, msg.value, job.milestonePayments.length);
    }

    /**
     * @dev Freelancer or client concludes job after original scope is done.
     *      Any remaining funds from added milestones are refunded to client.
     */
    function concludeJob(uint256 _jobId)
        external
        nonReentrant
        inState(_jobId, JobState.IN_PROGRESS)
    {
        Job storage job = jobs[_jobId];
        require(
            msg.sender == job.freelancer || msg.sender == job.client,
            "Not authorized"
        );
        require(
            job.completedMilestones >= job.originalMilestones,
            "Original scope not yet complete"
        );

        job.state = JobState.COMPLETED;
        uint256 refundAmount = job.escrowBalance;
        job.escrowBalance = 0;

        if (refundAmount > 0) {
            (bool success, ) = job.client.call{value: refundAmount}("");
            require(success, "Refund failed");
        }

        emit JobConcludedEarly(_jobId, refundAmount);
    }

    /**
     * @dev Anyone can tip the freelancer on an active job. Goes directly to freelancer.
     */
    function tipFreelancer(uint256 _jobId)
        external
        payable
        nonReentrant
    {
        Job storage job = jobs[_jobId];
        require(msg.value > 0, "Tip must be > 0");
        require(job.freelancer != address(0), "No freelancer assigned yet");
        require(
            job.state == JobState.IN_PROGRESS || job.state == JobState.COMPLETED,
            "Job not active"
        );

        (bool success, ) = job.freelancer.call{value: msg.value}("");
        require(success, "Tip failed");

        emit TipSent(_jobId, msg.sender, msg.value);
    }

    // -------------------------------------------------------
    // Dispute Functions
    // -------------------------------------------------------

    /**
     * @dev Client or freelancer raises a dispute. Freezes the contract.
     */
    function raiseDispute(uint256 _jobId)
        external
        inState(_jobId, JobState.IN_PROGRESS)
    {
        Job storage job = jobs[_jobId];
        require(
            msg.sender == job.client || msg.sender == job.freelancer,
            "Only client or freelancer"
        );

        job.state = JobState.IN_DISPUTE;

        emit DisputeRaised(_jobId, msg.sender);
    }

    /**
     * @dev Arbiter resolves dispute by splitting remaining escrow balance.
     * @param clientAmount ETH to send back to client
     * @param freelancerAmount ETH to send to freelancer
     */
    function resolveDispute(
        uint256 _jobId,
        uint256 clientAmount,
        uint256 freelancerAmount
    ) external nonReentrant inState(_jobId, JobState.IN_DISPUTE) {
        Job storage job = jobs[_jobId];
        require(msg.sender == job.arbiter, "Only arbiter");
        require(
            clientAmount + freelancerAmount == job.escrowBalance,
            "Amounts must equal remaining balance"
        );

        job.state = JobState.RESOLVED;
        job.escrowBalance = 0;

        if (clientAmount > 0) {
            (bool success, ) = job.client.call{value: clientAmount}("");
            require(success, "Client transfer failed");
        }
        if (freelancerAmount > 0) {
            (bool success, ) = job.freelancer.call{value: freelancerAmount}("");
            require(success, "Freelancer transfer failed");
        }

        emit DisputeResolved(_jobId, clientAmount, freelancerAmount);
    }

    // -------------------------------------------------------
    // View Functions
    // -------------------------------------------------------

    /**
     * @dev Returns milestone payment amounts for a job.
     */
    function getMilestones(uint256 _jobId)
        external
        view
        returns (uint256[] memory)
    {
        return jobs[_jobId].milestonePayments;
    }

    /**
     * @dev Returns remaining escrow balance for a job.
     */
    function getEscrowBalance(uint256 _jobId)
        external
        view
        returns (uint256)
    {
        return jobs[_jobId].escrowBalance;
    }
}