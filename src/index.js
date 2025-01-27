

// Require dependencies
const { assert } = require('chai');

// Require local dependencies
const DbApi       = require('./dbapi');
const DbModel     = require('./model');

const DbPlug      = require('./dbplug');

const MongoPlug   = require('./plugs/mongo');
const RethinkPlug = require('./plugs/rethink');

/**
 * Public DB API class
 */
class Db {
  /**
   * Construct public DB API class
   */
  constructor(dbPlug) {
    // Ensure dbPlug is a DbPlug instance
    assert.instanceOf(dbPlug, DbPlug, 'dbPlug must be a DbPlug instance');

    // Construct and store an internal DB API class
    this._dbApi = new DbApi(dbPlug);

    // Bind methods to self
    this.register = this.register.bind(this);
  }

  /**
   * Register a Model class with this database
   */
  async register(Model) {
    // Ensure Model is Model class
    assert.instanceOf(Model.prototype, DbModel, 'Model must be a DbModel extension');

    // Set internal DB class for the Model to be previously constructed internal DB API class
    Model.__db = this._dbApi;

    // Tell dbg to prepare for new collection
    await this._dbApi.initCollection(Model);
  }
}

// Export classes
module.exports = {
  Db,
  DbModel,

  plugs   : {
    MongoPlug,
    RethinkPlug,
  },
};
