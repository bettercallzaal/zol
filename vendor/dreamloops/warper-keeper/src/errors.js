class WarperKeeperError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code || "warper_keeper_error";
    for (const field of ["status", "remoteCode", "requestId", "correlationId", "timeoutMs"]) {
      if (options[field] !== undefined) this[field] = options[field];
    }
  }
}

class WarperKeeperConfigurationError extends WarperKeeperError {}
class WarperKeeperDisabledError extends WarperKeeperError {}
class WarperKeeperProtocolError extends WarperKeeperError {}
class WarperKeeperRemoteError extends WarperKeeperError {}
class WarperKeeperTimeoutError extends WarperKeeperError {}

module.exports = {
  WarperKeeperError,
  WarperKeeperConfigurationError,
  WarperKeeperDisabledError,
  WarperKeeperProtocolError,
  WarperKeeperRemoteError,
  WarperKeeperTimeoutError,
};
