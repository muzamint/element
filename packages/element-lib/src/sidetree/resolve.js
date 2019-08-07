const batchFileToOperations = require('../func/batchFileToOperations');
const reducer = require('../reducer');

module.exports = async (sidetree) => {
  // eslint-disable-next-line
  sidetree.resolve = async did => {
    let updatedState = {};
    const didUniqueSuffix = did.split(':').pop();

    const cachedRecord = await sidetree.db.read(`element:sidetree:did:elem:${didUniqueSuffix}`);
    let lastTransactionTime = 0;
    if (cachedRecord && cachedRecord.record) {
      updatedState = cachedRecord.record;
      lastTransactionTime = updatedState.lastTransaction.transactionTime;
    }

    let transactionTimeHash;
    try {
      const blockchainTime = await sidetree.blockchain.getBlockchainTime(lastTransactionTime);
      ({ transactionTimeHash } = blockchainTime);
    } catch (e) {
      const currentTime = await sidetree.blockchain.getCurrentTime();
      if (currentTime.time < lastTransactionTime) {
        // probably switched networks. we need to delete the cache,
        // and reload from scratch.
        await sidetree.db.write(`element:sidetree:did:elem:${didUniqueSuffix}`, {
          type: 'element:sidetree:did:documentRecord',
          networkChangeDetected: true,
        });
        lastTransactionTime = 0;
        const blockchainTime = await sidetree.blockchain.getBlockchainTime(lastTransactionTime);
        // eslint-disable-next-line
        transactionTimeHash = blockchainTime.transactionTimeHash;
      }
    }

    const transactions = await sidetree.getTransactions({
      since: 0,
      transactionTimeHash,
    });

    let items = transactions.map(transaction => ({
      transaction,
    }));

    items = await Promise.all(
      items.map(async item => ({
        ...item,
        anchorFile: await sidetree.getAnchorFile(item.transaction.anchorFileHash),
      })),
    );
    items = items.filter(item => !!item.anchorFile);

    // eslint-disable-next-line
    items = items.filter(item => {
      if (item.anchorFile.didUniqueSuffixes) {
        return item.anchorFile.didUniqueSuffixes.includes(didUniqueSuffix);
      }
      return true;
    });

    items = await Promise.all(
      items.map(async item => ({
        ...item,
        batchFile: await sidetree.getBatchFile(item.anchorFile.batchFileHash),
      })),
    );
    items = items.filter(item => !!item.batchFile);

    items = items.map(item => ({
      ...item,
      batchFileOperations: batchFileToOperations(item.batchFile),
    }));

    // todo: better types here..
    // flattened.
    items = [].concat(
      ...items.map(item => item.batchFileOperations.map(operation => ({
        operation,
        transaction: item.transaction,
      }))),
    );

    // unlike sync, resolve will not have state for other didUniqueSuffix,
    // they cannot be processed here.
    items = items.filter(
      item => item.operation.operationHash === didUniqueSuffix
        || item.operation.decodedOperationPayload.didUniqueSuffix === didUniqueSuffix,
    );
    // eslint-disable-next-line
    for (const anchoredOperation of items) {
      // eslint-disable-next-line
      updatedState = { ...(await reducer(updatedState, anchoredOperation, sidetree)) };
    }

    const record = updatedState[didUniqueSuffix];

    if (record) {
      await sidetree.db.write(`element:sidetree:did:elem:${didUniqueSuffix}`, {
        type: 'element:sidetree:did:documentRecord',
        record,
      });

      return updatedState[didUniqueSuffix].doc;
    }

    return null;
  };
};