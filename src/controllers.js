// NPM Dependencies
import axios from 'axios';
import shajs from 'sha.js';
import { giftWithdrawTry } from './models.js';

const lnpay = axios.create({
    baseURL: `https://api.lnpay.co/v1/wallet/${process.env.LNPAY_WALLET_KEY}`,
    timeout: 20000,
    headers: {
        'X-Api-Key': process.env.LNPAY_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

const getLnTx = id => axios.get(`https://api.lnpay.co/v1/lntx/${id}`, {
    headers: {
        'X-Api-Key': process.env.LNPAY_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
})

function lnpayError (error) {
    if (error.response && error.response.data.status) {
      error.message = `LNPay.co error ${error.response.data.status}: ${error.response.data.message}`;
    }

    error.message = 'LNPay.co error: ' + error.message;

    throw error;
}

export const createInvoice = async ({ giftId, amount, metadata }) => {
    const description = metadata
        ? undefined
        : `Lightning Gift for ${amount} sats`;

    const descriptionHash = metadata
        ? shajs('sha256').update(metadata).digest('hex')
        : undefined;

    try {
        const r = await lnpay.post('/invoice', {
            passThru: { giftId },
            num_satoshis: amount,
            memo: description,
            description_hash: descriptionHash
        });
        return r.data;
    } catch (error) {
        return lnpayError(error);
    }
};

export const getInvoiceStatus = async chargeId => {
    try {
        const r = await getLnTx(chargeId);
        const lntx = r.data;
        return lntx.settled === 0 ? 'unpaid' : 'paid';
    } catch (error) {
        return lnpayError(error);
    }
};

export const redeemGift = async ({ giftId, invoice }) => {
    giftWithdrawTry({
        giftId,
        reference: invoice
    });

    try {
        const r = await lnpay.post('/withdraw', {
            passThru: { giftId },
            payment_request: invoice
        });
        const data = r.data;
        return data.lnTx;
    } catch (error) {
        return lnpayError(error);
    }
};

export const checkRedeemStatus = async withdrawalId => {
    try {
        const r = await lnpay.get(`/withdrawal/${withdrawalId}`);
        return r.data;
    } catch (error) {
        return lnpayError(error);
    }
};
