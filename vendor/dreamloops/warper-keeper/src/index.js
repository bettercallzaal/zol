const {
  API_VERSION,
  CAPABILITY_ID,
  CONTRACT_VERSION,
  OPERATIONS,
  REQUIRED_TOOLS,
  TRANSPORT_CONTRACT,
} = require("./contracts/v1.js");
const { createWarperKeeperClient } = require("./client.js");
const {
  WarperKeeperConfigurationError,
  WarperKeeperDisabledError,
  WarperKeeperError,
  WarperKeeperProtocolError,
  WarperKeeperRemoteError,
  WarperKeeperTimeoutError,
} = require("./errors.js");

module.exports = {
  API_VERSION,
  CAPABILITY_ID,
  CONTRACT_VERSION,
  OPERATIONS,
  REQUIRED_TOOLS,
  TRANSPORT_CONTRACT,
  createWarperKeeperClient,
  WarperKeeperConfigurationError,
  WarperKeeperDisabledError,
  WarperKeeperError,
  WarperKeeperProtocolError,
  WarperKeeperRemoteError,
  WarperKeeperTimeoutError,
};
