// Lets another address push prices to a MockOracle deployment (e.g. a feeder on another machine).
// Run as the oracle owner: REPORTER=0x... npx hardhat run scripts/set-reporter.js --network <net>
// Set ALLOWED=false to revoke.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");

const { ethers } = hre;

async function main() {
  const reporter = process.env.REPORTER;
  if (!reporter || !ethers.isAddress(reporter)) throw new Error("Set REPORTER to the feeder's address");
  const allowed = process.env.ALLOWED !== "false";
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  if (d.oracleType !== "mock") throw new Error("Reporters only exist on MockOracle deployments");
  const oracle = await ethers.getContractAt("MockOracle", d.oracle);
  await (await oracle.setReporter(reporter, allowed)).wait();
  console.log(`${reporter} ${allowed ? "can now" : "can no longer"} push prices to ${d.oracle}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
