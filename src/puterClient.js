const { init } = require("@heyputer/puter.js/src/init.cjs");

function createPuterClient(authToken) {
  if (!authToken) {
    throw new Error("Missing Puter auth token");
  }

  return init(authToken);
}

module.exports = {
  createPuterClient
};
