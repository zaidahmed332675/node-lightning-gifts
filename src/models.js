// NPM Dependencies
import axios from 'axios';
import admin from 'firebase-admin';

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

export const getGiftInfo = giftId =>
    dbRef
        .doc(giftId)
        .get()
        .then(doc => {
            if (!doc.exists) {
                return null;
            } else {
                return doc.data();
            }
        })
        .catch(() => null);

export const createGift = ({
    giftId, chargeId, amount, chargeInvoice, chargeStatus, notify, senderName, senderMessage, verifyCode
}) => dbRef
        .doc(giftId)
        .set({
            id: giftId,
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
            verifyCode,
            notify
        });

export const updateGiftChargeStatus = ({ giftId, chargeStatus }) =>
    dbRef
        .doc(giftId)
        .update({ chargeStatus });

export const giftWithdrawTry = ({ giftId, reference }) =>
    dbRef
        .doc(giftId)
        .update({
            spent: 'pending',
            withdrawalInfo: {
                withdrawalInvoice: reference,
                createdAt: admin.firestore.Timestamp.now()
            }
        });

export const giftWithdrawSuccess = ({ giftId, withdrawalId, fee }) => {
    dbRef
        .doc(giftId)
        .update({
            spent: true,
            'withdrawalInfo.fee': fee,
            'withdrawalInfo.withdrawalId': withdrawalId
        });

    dbRef
        .doc(giftId)
        .get()
        .then(snapshot => {
            let data = snapshot.data();

            if (data.notify) {
                axios.post(data.notify, {
                    id: data.id,
                    orderId: data.id,
                    amount: data.amount,
                    spent: true
                }, { timeout: 2000 })
            }
        });
}

export const giftWithdrawFail = ({ giftId, error }) =>
    dbRef
        .doc(giftId)
        .update({
            spent: false,
            withdrawalInfo: { error }
        })
        .catch(error => {
            throw error;
        });
