const fs = require("fs");
const path = require("path");

const DEPLOYMENTS_FILE = path.join(__dirname, "../../frontend/src/config/deployments.json");
const ABI_FILE = path.join(__dirname, "../../frontend/src/config/abis.json");

function readDeployments() {
  return fs.existsSync(DEPLOYMENTS_FILE) ? JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8")) : {};
}

function readDeployment(chainId) {
  const d = readDeployments()[String(chainId)];
  if (!d) throw new Error(`No deployment for chain ${chainId} in ${DEPLOYMENTS_FILE}. Run the deploy script first.`);
  return d;
}

function writeDeployment(chainId, deployment) {
  const all = readDeployments();
  all[String(chainId)] = deployment;
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(all, null, 2) + "\n");
}

/** Exports the ABIs the frontend needs so it builds without Hardhat artifacts. */
async function exportAbis(hre) {
  const pick = async (name) => (await hre.artifacts.readArtifact(name)).abi;
  const abis = {
    PerpExchange: await pick("PerpExchange"),
    MockOracle: await pick("MockOracle"),
    MockUSDC: await pick("MockUSDC"),
  };
  fs.writeFileSync(ABI_FILE, JSON.stringify(abis, null, 2) + "\n");
}

module.exports = { readDeployment, writeDeployment, exportAbis };
