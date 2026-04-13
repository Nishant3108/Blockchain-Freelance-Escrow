import hre from "hardhat";

async function main() {
  console.log("Deploying FreelanceEscrow...");

  const connection = await (hre as any).network.connect();
  const ethers = connection.ethers;

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with wallet:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Wallet balance:", ethers.formatEther(balance), "ETH");

  const FreelanceEscrow = await ethers.getContractFactory("FreelanceEscrow");
  const contract = await FreelanceEscrow.deploy();

  console.log("Waiting for deployment transaction...");
  const deployTx = await contract.deploymentTransaction();
  console.log("Transaction hash:", deployTx?.hash);

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("FreelanceEscrow deployed to:", address);
  console.log("Etherscan:", "https://sepolia.etherscan.io/address/" + address);
  console.log("Tx:", "https://sepolia.etherscan.io/tx/" + deployTx?.hash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});