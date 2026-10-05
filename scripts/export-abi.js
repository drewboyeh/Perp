const hre = require("hardhat");
const { exportAbis } = require("./lib/deployments");

exportAbis(hre).then(() => console.log("ABIs exported to frontend/src/config/abis.json"));
