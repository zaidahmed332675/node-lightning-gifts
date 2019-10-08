// NPM Dependencies
const admin = require('firebase-admin');

// Module Dependencies
const { notifyRedeem } = require('./controllers');

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_ID,
        clientEmail: process.env.FIREBASE_EMAIL,
        privateKey: JSON.parse(`"${process.env.FIREBASE_KEY}"`)
    })
});

const db = admin.firestore();
const giftDb = process.env.NODE_ENV === 'production' ? 'prod-gifts' : 'dev-gifts';
const dbRef = db.collection(giftDb);

exports.getGiftInfo = orderId =>
    dbRef
        .doc(orderId)
        .get()
        .then(doc => {
            if (!doc.exists) {
                return null;
            } else {
                return doc.data();
            }
        })
        .catch(err => {
            return null;
        });

exports.createGift = ({ orderId, chargeId, amount, chargeInvoice, chargeStatus, notify, senderName, senderMessage }) =>
    dbRef
        .doc(orderId)
        .set({
            id: orderId,
            amount: Number(amount),
            chargeInfo: {
                chargeId,
                chargeInvoice
            },
            spent: false,
            chargeStatus,
            createdAt: admin.firestore.Timestamp.now(),
            senderName,
            senderMessage,
            notify
        });

exports.updateGiftChargeStatus = ({ orderId, chargeStatus }) =>
    dbRef
        .doc(orderId)
        .update({ chargeStatus });

exports.giftWithdrawTry = ({ orderId, withdrawalId, reference }) =>
    dbRef
        .doc(orderId)
        .update({
            spent: 'pending',
            withdrawalInfo: {
                withdrawalId,
                withdrawalInvoice: reference,
                createdAt: admin.firestore.Timestamp.now()
            }
        });

exports.giftWithdrawSuccess = ({ withdrawalId, fee }) =>
    dbRef
        .where('withdrawalInfo.withdrawalId', '==', withdrawalId)
        .get()
        .then(snapshot => {
            if (snapshot.empty) {
                console.log('No matching withdrawalIds');
                return null;
            }

            snapshot.forEach(doc => {
                dbRef
                    .doc(doc.id)
                    .set({
                        spent: true,
                        withdrawalInfo: { fee }
                    }, { merge: true });

                notifyRedeem(doc.data());
            });
        })
        .catch(error => {
            throw error;
        });

exports.giftWithdrawFail = ({ withdrawalId, error }) =>
    dbRef
        .where('withdrawalInfo.withdrawalId', '==', withdrawalId)
        .get()
        .then(snapshot => {
            if (snapshot.empty) {
                console.log('No matching withdrawalIds');
                return null;
            }

            snapshot.forEach(doc => {
                dbRef
                    .doc(doc.id)
                    .set({
                        spent: false,
                        withdrawalInfo: { error }
                    }, { merge: true });
            });
        })
        .catch(error => {
            throw error;
        });
