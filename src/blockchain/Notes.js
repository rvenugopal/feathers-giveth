import TransferQueue from './TransferQueue';

const BreakSignal = () => {
};

class Notes {
  constructor(app, liquidPledging) {
    this.app = app;
    this.web3 = liquidPledging.$web3;
    this.liquidPledging = liquidPledging;
    this.queue = new TransferQueue();
    this.blockTimes = {};
    this.fetchingBlocks = {};
  }

  // handle liquidPledging Transfer event
  transfer(event) {
    if (event.event !== 'Transfer') throw new Error('transfer only handles Transfer events');

    const { from, to, amount } = event.returnValues;

    this._getBlockTimestamp(event.blockNumber)
      .then(ts => {
        if (from === '0') return this._newDonation(to, amount, ts, event.transactionHash);

        return this._transfer(from, to, amount, ts, event.transactionHash);
      });
  }

  _newDonation(noteId, amount, ts, txHash, retry = false) {
    const donations = this.app.service('donations');
    const noteManagers = this.app.service('noteManagers');

    const findDonation = () => donations.find({ query: { txHash } })
      .then(resp => {
        return (resp.data.length > 0) ? resp.data[ 0 ] : undefined;
      });

    this.liquidPledging.getNote(noteId)
      .then((note) => Promise.all([ noteManagers.get(note.owner), note, findDonation() ]))
      .then(([ donor, note, donation ]) => {
        const mutation = {
          donorAddress: donor.manager.address, // donor is a user
          amount,
          noteId,
          createdAt: ts,
          owner: note.owner,
          ownerId: donor.typeId,
          ownerType: donor.type,
          status: 'waiting', // waiting for delegation by owner or delegate
          paymentState: this._paymentState(note.paymentState),
        };

        if (!donation) {
          // do we need to add type & typeId here? I don't think so as a new donation will always be immediately followed
          // by a transfer event which we can set the type there
          if (retry) return donations.create(Object.assign(mutation, { txHash }));

          // this is really only useful when instant mining. Other then that, the donotation should always be
          // created before the tx was mined.
          setTimeout(() => this._newDonation(noteId, amount, ts, txHash, true), 5000);
          throw new BreakSignal();
        }

        return donations.patch(donation._id, mutation);
      })
      // now that this donation has been added, we can purge the transfer queue for this noteId
      .then(() => this.queue.purge(noteId))
      .catch((err) => {
        if (err instanceof BreakSignal) return;
        console.error(err); // eslint-disable-line no-console
      });

  }

  _transfer(from, to, amount, ts, txHash) {
    const donations = this.app.service('donations');
    const noteManagers = this.app.service('noteManagers');

    const getDonation = () => {
      return donations.find({ query: { noteId: from, txHash } })
        .then(donations => (donations.data.length > 0) ? donations.data[ 0 ] : undefined);
    };

    Promise.all([ this.liquidPledging.getNote(from), this.liquidPledging.getNote(to) ])
      .then(([ fromNote, toNote ]) => {
        const promises = [
          noteManagers.get(fromNote.owner),
          noteManagers.get(toNote.owner),
          fromNote,
          toNote,
          getDonation(),
        ];

        // In lp any delegate in the chain can delegate (bug prevents that currently), but we only want the last delegate
        // to have that ability
        if (toNote.nDelegates > 0) {
          promises.push(
            this.liquidPledging.getNoteDelegate(to, toNote.nDelegates)
              .then(delegate => noteManagers.get(delegate.idDelegate))
          );
        } else {
          promises.push(undefined);
        }

        // fetch proposedProject noteManager
        if (toNote.proposedProject > 0) {
          promises.push(noteManagers.get(toNote.proposedProject));
        } else {
          promises.push(undefined);
        }

        return Promise.all(promises);
      })
      .then(([ fromNoteManager, toNoteManager, fromNote, toNote, donation, delegate, proposedProject ]) => {

        const transferInfo = {
          fromNoteManager,
          toNoteManager,
          fromNote,
          toNote,
          toNoteId: to,
          delegate,
          proposedProject,
          donation,
          amount,
          ts,
        };

        if (donation) return this._doTransfer(transferInfo);

        // if donation doesn't exist where noteId === from, then add to transferQueue.
        this.queue.add(
          from,
          () => getDonation()
            .then(d => {
              transferInfo.donation = d;
              return this._doTransfer(transferInfo);
            }),
        );

      })
      .catch(console.error);
  }

  _doTransfer(transferInfo) {
    const donations = this.app.service('donations');
    const { fromNoteManager, toNoteManager, fromNote, toNote, toNoteId, delegate, proposedProject, donation, amount, ts } = transferInfo;

    let status;
    if (proposedProject) status = 'to_approve';
    else if (toNoteManager.type === 'user' || delegate) status = 'waiting';
    else status = 'committed';

    if (donation.amount === amount) {
      // this is a transfer

      // if (fromNote.owner === toNote.owner) {
      // this is a delegation

      const mutation = {
        // delegates: toNote.delegates,
        amount,
        paymentState: this._paymentState(toNote.paymentState),
        updatedAt: ts,
        owner: toNote.owner,
        ownerId: toNoteManager.typeId,
        ownerType: toNoteManager.type,
        proposedProject: toNote.proposedProject,
        noteId: toNoteId,
        status,
      };

      if (proposedProject) {
        Object.assign(mutation, {
          proposedProjectId: proposedProject.typeId,
          proposedProjectType: proposedProject.type,
        });
      }

      if (delegate) {
        Object.assign(mutation, {
          delegate: delegate.id,
          delegateId: delegate.typeId,
        });
      }

      //TODO donationHistory entry
      donations.patch(donation._id, mutation)
        .then(this._updateDonationHistory(transferInfo));

      return;
      // }
    } else {
      // this is a split

      //TODO donationHistory entry
      donations.patch(donation._id, {
          amount: donation.amount - amount,
        })
        //TODO update this
        .then(() => donations.create({
          donorAddress: donation.donorAddress,
          amount,
          toNoteId,
          createdAt: ts,
          owner: toNoteManager.typeId,
          ownerType: toNoteManager.type,
          proposedProject: toNote.proposedProject,
          paymentState: this._paymentState(toNote.paymentState),
        }))
        // now that this donation has been added, we can purge the transfer queue for this noteId
        .then(() => this.queue.purge(toNoteId));
    }

  }

  _updateDonationHistory(transferInfo) {
    const donationsHistory = this.app.service('donations/:donationId/history');
    const { fromNoteManager, toNoteManager, fromNote, toNote, toNoteId, donation, amount, ts } = transferInfo;

    if (toNote.paymentStatus === 'Paying' || toNote.paymentStatus === 'Paid') {
      // payment has been initiated/completed in vault
      return donationsHistory.create({
        status: (toNote.paymentStatus === 'Paying') ? 'Payment Initiated' : 'Payment Completed',
        createdAt: ts,
      }, { donationId: donation._id });
    }

    // canceled payment from vault

    // vetoed delegation

    // regular transfer

  }

  _paymentState(val) {
    switch (val) {
      case '0':
        return 'NotPaid';
      case '1':
        return 'Paying';
      case '2':
        return 'Paid';
      default:
        return 'Unknown';
    }
  }

  _getBlockTimestamp(blockNumber) {
    if (this.blockTimes[ blockNumber ]) return Promise.resolve(this.blockTimes[ blockNumber ]);

    // if we are already fetching the block, don't do it twice
    if (this.fetchingBlocks[ blockNumber ]) {
      return new Promise(resolve => {
        // attach a listener which is executed when we get the block ts
        this.fetchingBlocks[ blockNumber ].push(resolve);
      });
    }

    this.fetchingBlocks[ blockNumber ] = [];

    return this.web3.eth.getBlock(blockNumber)
      .then(block => {
        const ts = new Date(block.timestamp * 1000);

        this.blockTimes[ blockNumber ] = ts;

        // only keep 50 block ts cached
        if (Object.keys(this.blockTimes).length > 50) {
          Object.keys(this.blockTimes)
            .sort((a, b) => b - a)
            .forEach(key => delete this.blockTimes[ key ]);
        }

        // execute any listeners for the block
        this.fetchingBlocks[ blockNumber ].forEach(resolve => resolve(ts));
        delete this.fetchingBlocks[ blockNumber ];

        return ts;
      });
  }
}

export default Notes;