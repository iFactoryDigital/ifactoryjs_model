

// Require dependencies
const R       = require('rethinkdb');
const RPool   = require('rethinkdb-pool');
// const RE2     = require ('re2');

// Require local dependencies
const DbPlug = require('../dbplug');

/**
 * Convert a RegExp object to a RethinkDB-compatible Regex string
 */
function regexToGoodString(re) {
  // Create a string of the RegExp object from RE2
  // const baseStr = (new RE2 (re)).toString ();
  const baseStr = re.toString();

  // Match the base components of the Regex string
  const baseStrMatch = baseStr.match(/\/(.*)\/(.*)/);

  // Create a string that will be the appropriate format for flags
  const flagStr = baseStrMatch[2].length > 0 ? `(?${baseStrMatch[2]})` : '';

  // Return the reconstructed Regex string
  return `${flagStr}${baseStrMatch[1]}`;
}

/**
 * Swap two keys in an object around
 */
function swapKeys(key1, key2, obj) {
  // Create new copy of object so not to modify by reference
  const swappedObj = Object.assign({}, obj);

  // Get references to existing values
  const val1 = swappedObj.hasOwnProperty(key1) ? swappedObj[key1] : null;
  const val2 = swappedObj.hasOwnProperty(key2) ? swappedObj[key2] : null;

  // Delete being-swapped values from the object
  delete swappedObj[key1];
  delete swappedObj[key2];

  // Re-apply the found references
  if (val1 != null) swappedObj[key2] = val1;
  if (val2 != null) swappedObj[key1] = val2;

  // Return the updated object
  return swappedObj;
}

/**
 * Use a dotProp-style key to find a nested property in a Rethinkdb object cursor
 */
function dotPropRethinkKey(key, initialCursor = null) {
  const keyParts = key.split('.');
  let objectCursor = null;

  // Iterate parts of key
  for (let keyPart of keyParts) {
    // If is first part or not
    if (objectCursor == null) {
      // Swap `_id` and `id`
      if (keyPart === 'id') {
        keyPart = '_id';
      } else if (keyPart === '_id') {
        keyPart = 'id';
      }

      // Set first cursor part to be "brackets" selected subprop of either initialCursor or R.row
      objectCursor = (initialCursor != null ? initialCursor : R.row)(keyPart);
    } else {
      // Use rethink "brackets" to select subprop
      objectCursor = objectCursor(keyPart);
    }
  }

  // Return new cursor constructed from key
  return objectCursor;
}

/**
 * Deeply match an object supporting dotprop keys and regex
 */
function deepMatch(match, initialCursor = null) {
  // Variable for storing RethinkDB ready filter
  let filterPart = null;

  // Iterate all properties of provided object
  for (const [filterKey, filterVal] of Object.entries(match)) {
    // Variable for storing single constructed part of match
    let filterPartMatch = null;

    // Handle regex with `match` and others with `eq`
    if (filterVal instanceof RegExp) {
      // Create rethinkdb-friendly regex string and apply to new match part
      const regexString = regexToGoodString(filterVal).toString();
      filterPartMatch = dotPropRethinkKey(filterKey, initialCursor).match(regexString);
    } else {
      // Apply eq to new match part
      filterPartMatch = dotPropRethinkKey(filterKey, initialCursor).default(null).eq(filterVal);
    }

    // If existing filter data, append this as clause, otherwise set this as filter data
    filterPart = (filterPart != null ? filterPartMatch.and(filterPart) : filterPartMatch);
  }

  // Return RethinkDB-ready filter
  return filterPart != null ? filterPart : {};
}

/**
 * RethinkDb database plug class
 */
class RethinkPlug extends DbPlug {
  /**
   * Construct RethinkDb database plug class
   */
  constructor(config) {
    super();

    this._indexes = new Map();

    // Store map of promises that resolve when table is ready
    this._preparedTables = new Map();

    // Store config
    this._config = config;

    // Bind builder to self
    this._build = this._build.bind(this);

    // Bind raw methods to self
    this.getRawCursor = this.getRawCursor.bind(this);
    this.getRawTable = this.getRawTable.bind(this);
    this.getRawDb = this.getRawDb.bind(this);

    // Bind internal methods to self
    this._queryToCursor = this._queryToCursor.bind(this);
    this._getTable = this._getTable.bind(this);
    this._fetchDocs = this._fetchDocs.bind(this);
    this._fetchDoc = this._fetchDoc.bind(this);
    this._handleRawModel = this._handleRawModel.bind(this);

    // Bind public methods to self
    this.findById = this.findById.bind(this);
    this.find = this.find.bind(this);
    this.findOne = this.findOne.bind(this);
    this.count = this.count.bind(this);
    this.removeById = this.removeById.bind(this);
    this.remove = this.remove.bind(this);
    this.replaceById = this.replaceById.bind(this);
    this.insert = this.insert.bind(this);

    // Start building internal connections and store promise
    this._building = this._build();
  }

  /**
   * Async method that resolves on internal API build completion
   */
  async _build() {
    // Connect to rethinkdb pool
    this._rethinkConn = RPool(R, this._config);
  }

  /**
   * Prepare database for new collection of provided collection ID
   */
  async initCollection(collectionId, indexes = new Set()) {
    // If this collection has already been initiated, ignore
    if (this._preparedTables.has(collectionId)) return;

    await this._building;

    // Add promise that resolves when table created to prepared tables promise map
    this._preparedTables.set(collectionId, (async () => {
      // Check if table already exists
      const tableExists = await this._rethinkConn.run(R.tableList().contains(collectionId));

      // Create if doesn't already exist
      if (!tableExists) await this._rethinkConn.run(R.tableCreate(collectionId));

      // Await table creation
      await this._rethinkConn.run(R.table(collectionId).wait());
    })());
  }

  async createIndex(collectionId, name, indexes) {
    // Get keys of all provided indexed props
    const indexKeys = Object.keys(indexes);
    // Generate standard format rethinkdb index name from index keys
    const rethinkIndexName = indexKeys.sort().join('+');

    // If set of indexes doesn't already exist for specific `collectionId`
    if (this._indexes.get(collectionId) == null) {
      // Create set of indexes with this index name included
      this._indexes.set(collectionId, new Set([rethinkIndexName]));
    } else {
      // Add index name to set of indexes
      this._indexes.get(collectionId).add(rethinkIndexName);
    }

    await this._building;

    // Catch all errors since will error if already exists (safe to ignore)
    try {
      // If only single prop being indexed
      if (indexKeys.length === 1) {
        // Create index for specific prop by rethinkdb path generated from index key
        await this._rethinkConn.run(R.table(collectionId).indexCreate(rethinkIndexName, dotPropRethinkKey(indexKeys[0])));
      } else {
        // Create index for array of prop by rethinkdb paths generated from index keys
        await this._rethinkConn.run(R.table(collectionId).indexCreate(rethinkIndexName, indexKeys.sort().map(indexKey => dotPropRethinkKey(indexKey))));
      }
    } catch (err) { }

    // Await the index's creation
    await this._rethinkConn.run(R.table(collectionId).indexWait(rethinkIndexName));
  }

  /**
  * Return a copy of a raw cursor by provided tableName
  */
  async getRawCursor(tableName) {
    await this._building;

    return await this._getTable(tableName);
  }

  /**
  * Return a copy of a raw table by provided table name
  */
  async getRawTable(tableName) {
    await this._building;

    return await this._getTable(tableName);
  }

  /**
  * Return a copy of the raw internal database
  */
  async getRawDb(tableName) {
    await this._building;
    return this._rethinkConn;
  }

  /**
   * Get a table by provided table name, ensuring table exists
   */
  async _getTable(tableName) {
    await this._preparedTables.get(tableName);

    // Return table by name
    return R.table(tableName);
  }

  /**
   * Fetch docs by a provided cursor
   */
  async _fetchDocs(cursor) {
    // Get docs from executing provided cursor
    const docs = await this._rethinkConn.run(cursor);

    // Return fetched docs
    return docs;
  }

  /**
   * Fetch single doc by provided cursor
   */
  async _fetchDoc(cursor) {
    // Limit cursor to 1 and get docs from executing provided cursor
    const docs = await this._rethinkConn.run(cursor.limit(1));

    // Return only fetched doc
    return docs[0] || null;
  }

  /**
   * Convert a standard constructed query to a RethinkDb cursor
   */
  async _queryToCursor(collectionId, query) {
    // Create a cursor from fetching a table by `collectionId`
    let cursor = await this._getTable(collectionId);
    // Whether or not the cursor is still a table
    let cursorIsTable = true;

    // Iterate all query parts to build a query
    for (const queryPt of query.pts) {
      if (queryPt.type === 'filter') {
        // Generate standard format rethinkdb index name from filter
        const rethinkIndexName = Object.keys(queryPt.filter).sort().join('+');

        // If cursor is still table and an index by the generated name has been registered
        if (cursorIsTable && this._indexes.has(collectionId) && this._indexes.get(collectionId).has(rethinkIndexName)) {
          // Sort the object values by the same standard as the object keys
          const values = Object.entries(queryPt.filter).sort(([aKey], [bKey]) => {
            return aKey.localeCompare(bKey);
          }).map(filterEntry => filterEntry[1]);

          // If there is only a single value
          if (values.length === 1) {
            // Index-based query using single indexed value
            cursor = cursor.getAll(values[0], { index : rethinkIndexName });
          } else {
            // Index-based query using sorted array of object values
            cursor = cursor.getAll(values, { index : rethinkIndexName });
          }
        } else {
          // Filter using generated deep-match-filter from filter
          cursor = cursor.filter(deepMatch(queryPt.filter));
        }
      } else if (queryPt.type === 'elem') {
        // Apply `filter` method to cursor to filter out models that do not have array elements matching filter
        cursor = cursor.filter(dotPropRethinkKey(queryPt.arrKey).contains((elem) => {
          if (typeof queryPt.filter !== 'object') {
            return elem.eq(queryPt.filter);
          }
          return deepMatch(queryPt.filter, elem);
        }));
      } else if (queryPt.type === 'ne') {
        // Add a custom filter method to the cursor
        cursor = cursor.filter(dotPropRethinkKey(queryPt.key).default(null).ne(queryPt.val));
      } else if (queryPt.type === 'nin') {
        // Add a custom filter method to the cursor
        // TODO: use a lambda instead of multiple `ne`s
        for (const val of queryPt.vals) {
          cursor = cursor.filter(dotPropRethinkKey(queryPt.key).default(null).ne(val));
        }
      } else if (queryPt.type === 'in') {
        if (cursorIsTable && this._indexes.has(collectionId) && this._indexes.get(collectionId).has(queryPt.key)) {
          cursor = cursor.getAll(R.args(queryPt.vals), { index : queryPt.key });
        } else {
          const inMatchFilters = [];

          // Add a custom filter method to the cursor
          // TODO: use a lambda instead of multiple `eq`s
          for (const val of queryPt.vals) {
            inMatchFilters.push(deepMatch({ [queryPt.key] : val }));
          }

          if (inMatchFilters.length === 0) {
            // If no filters, do nothing
          } else if (inMatchFilters.length === 1) {
            // If 1 filter, provide as only filter
            cursor = cursor.filter(inMatchFilters[0]);
          } else if (inMatchFilters.length) {
            // If 2 or more filters, use all as `or` arguments to use in filter
            cursor = cursor.filter(R.or(...inMatchFilters));
          }
        }
      } else if (queryPt.type === 'whereOr') {
        // Iterate query part possible match objects to make RethinkDB ready filters
        const orMatchFilters = queryPt.matches.map(match => deepMatch(match));

        if (orMatchFilters.length === 0) {
          // If no filters, do nothing
        } else if (orMatchFilters.length === 1) {
          // If 1 filter, provide as only filter
          cursor = cursor.filter(orMatchFilters[0]);
        } else if (orMatchFilters.length) {
          // If 2 or more filters, use all as `or` arguments to use in filter
          cursor = cursor.filter(R.or(...orMatchFilters));
        }
      } else if (queryPt.type === 'whereAnd') {
        // Iterate query part possible match objects to make RethinkDB ready filters
        const andMatchFilters = queryPt.matches.map(match => deepMatch(match));

        if (andMatchFilters.length === 0) {
          // If no filters, do nothing
        } else if (andMatchFilters.length === 1) {
          // If 1 filter, provide as only filter
          cursor = cursor.filter(andMatchFilters[0]);
        } else if (andMatchFilters.length) {
          // If 2 or more filters, use all as `and` arguments to use in filter
          cursor = cursor.filter(R.and(...andMatchFilters));
        }
      } else if (queryPt.type === 'limit') {
        // Apply amt to `limit` cursor method
        cursor = cursor.limit(queryPt.limitAmount);
      } else if (queryPt.type === 'skip') {
        // Apply amt to `skip` cursor method
        cursor = cursor.skip(queryPt.skipAmount);
      } else if (queryPt.type === 'sort') {
        // If cursor is still table and an index with the sortKey as name has been registered
        if (cursorIsTable && this._indexes.has(collectionId) && this._indexes.get(collectionId).has(queryPt.sortKey)) {
          // Index-based sort using the provided key
          cursor = cursor.orderBy(queryPt.desc ? { index : R.desc(queryPt.sortKey) } : { index : R.asc(queryPt.sortKey) });
        } else {
          // Order by sort using generated rethinkdb path from provided sort key
          cursor = cursor.orderBy(queryPt.desc ? R.desc(dotPropRethinkKey(queryPt.sortKey)) : R.asc(dotPropRethinkKey(queryPt.sortKey)));
        }
      } else if (queryPt.type === 'gt') {
        // Create `gt` filter using provided key and min and apply to `filter` cursor method
        cursor = cursor.filter(dotPropRethinkKey(queryPt.key).gt(queryPt.min));
      } else if (queryPt.type === 'lt') {
        // Create `lt` filter using provided key and min and apply to `filter` cursor method
        cursor = cursor.filter(dotPropRethinkKey(queryPt.key).lt(queryPt.max));
      } else if (queryPt.type === 'gte') {
        // Create `gte` filter using provided key and min and apply to `filter` cursor method
        cursor = cursor.filter(dotPropRethinkKey(queryPt.key).ge(queryPt.min));
      } else if (queryPt.type === 'lte') {
        // Create `lte` filter using provided key and min and apply to `filter` cursor method
        cursor = cursor.filter(dotPropRethinkKey(queryPt.key).le(queryPt.max));
      }

      // First iteration finished, must no longer be table
      cursorIsTable = false;
    }

    // Return the fully constructed cursor
    return cursor;
  }

  /**
   * Parsed DB-stored data into safe Model instance data components
   */
  _handleRawModel(rawModelObject) {
    // If no Model instance data found, return null
    if (rawModelObject == null) {
      return null;
    }

    // Swap `id` and `_id` around for compatibility without possibly conflicting props
    const object = swapKeys('id', '_id', rawModelObject);

    // Extract Model ID from raw data
    const modelId = object._id;
    delete object._id;

    // Return correctly structured fetched Model instance data
    return {
      id     : modelId,
      object,
    };
  }

  /**
   * Find Model data by collection ID and Model ID
   */
  async findById(collectionId, id) {
    // Wait for building to finish
    await this._building;

    // Get table by provided collection ID
    const table = await this._getTable(collectionId);

    // get doc
    const rawModelRes = await this._rethinkConn.run(table.get(id));

    // Parse raw model data to model data and return
    return this._handleRawModel(rawModelRes);
  }

  /**
   * Find Model data by collection ID and constructed query
   */
  async find(collectionId, query) {
    // Wait for building to finish
    await this._building;

    // Fetch, map, and return found Model instance data found by cursor constructed from provided query
    return (await this._fetchDocs(await this._queryToCursor(collectionId, query))).map((rawModelRes) => {
      // Parse raw model data to model data
      return this._handleRawModel(rawModelRes);
    });
  }

  /**
   * Find single Model data by collection ID and Model ID
   */
  async findOne(collectionId, query) {
    // Wait for building to finish
    await this._building;

    // Construct cursor from provided query, and use it to fetch single Model instance data
    const rawModelRes = await this._fetchDoc(await this._queryToCursor(collectionId, query));

    // Parse raw model data to model data and return
    return this._handleRawModel(rawModelRes);
  }

  /**
   * Get count of Model data by collection ID and constructed query
   */
  async count(collectionId, query) {
    // Wait for building to finish
    await this._building;

    // Fetch count of matching Model instance data
    return await this._rethinkConn.run((await this._queryToCursor(collectionId, query)).count());
  }

  /**
   * Get sum of data by provided key of all matching Model data by collection ID and constructed query
   */
  async sum(collectionId, query, key) {
    // Fetch sum of matching Model instance data's matching fields
    return await this._rethinkConn.run((await this._queryToCursor(collectionId, query)).sum(key));
  }

  /**
   * Remove matching Model data from database by collection ID and Model ID
   */
  async removeById(collectionId, id) {
    // Wait for building to finish
    await this._building;

    // Get table by provided collection ID
    const table = await this._getTable(collectionId);

    // Find and remove single Model instance data by provided ID
    await this._rethinkConn.run(table.get(id).delete());
  }

  /**
   * Remove matching Model data from database by collection ID and constructed query
   */
  async remove(collectionId, query) {
    // Wait for building to finish
    await this._building;

    // Find and remove matching Model instance data by provided query
    await this._rethinkConn.run((await this._queryToCursor(collectionId, query)).delete());
  }

  /**
   * Replace matching Model data from database by collection ID, Model ID, and replacement data
   */
  async replaceById(collectionId, id, newObject) {
    // Wait for building to finish
    await this._building;

    // Get table by provided collection ID
    const table = await this._getTable(collectionId);

    // Swap the ID keys in the object before setting the ID
    const swappedReplaceObject = swapKeys('id', '_id', newObject);

    // Set `id` of the data to be the Model instance's db data ID
    swappedReplaceObject.id = id;

    // Execute replace query using provided cursor and provided replacement object
    await this._rethinkConn.run(table.get(id).replace(swappedReplaceObject));
  }

  /**
   * Update matching Model data from database by collection ID, Model ID, replacement data, and set of updated keys
   */
  async updateById(collectionId, id, newObject, updates) {
    // Wait for building to finish
    await this._building;

    // Get table by provided collection ID
    const table = await this._getTable(collectionId);

    // Filter to only top level key updates
    const topLevelUpdates = new Set(Array.from(updates).map(update => update.split('.')[0]));

    // Create new object for storing only updated keys
    const replaceObject = {};

    // Iterate updated keys
    await Promise.all(Array.from(topLevelUpdates).map(async (updatedKey) => {
      if (newObject[updatedKey] != undefined) {
        // Set replace object key-val to be from new object
        replaceObject[updatedKey] = newObject[updatedKey];
      } else {
        // Remove the key if undefined in new object
        await this._rethinkConn.run(table.get(id).replace(R.row.without(updatedKey)));
      }
    }));

    // Swap the ID keys in the object before setting the ID
    const swappedReplaceObject = swapKeys('id', '_id', newObject);

    // Set `id` of the data to be the Model instance's db data ID
    swappedReplaceObject.id = id;

    // Execute replace query using provided cursor and provided replacement object
    await this._rethinkConn.run(table.get(id).update(swappedReplaceObject));
  }

  /**
   * Insert Model data from database by collection ID and return Model ID
   */
  async insert(collectionId, object) {
    // Wait for building to finish
    await this._building;

    // Get table by provided collection ID
    const table = await this._getTable(collectionId);

    // Insert provided object data into provided table and get response
    const insertRes = await this._rethinkConn.run(table.insert(swapKeys('id', '_id', object)));

    // Return Model ID from insertation response
    return insertRes.generated_keys[0];
  }
}

// Exports
module.exports = RethinkPlug;
