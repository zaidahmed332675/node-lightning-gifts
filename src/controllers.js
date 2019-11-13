// NPM Dependencies
const axios = require('axios');

const openNodeApi = axios.create({
    baseURL: 'https://api.opennode.co/v1',
    timeout: 15000,
    headers: {
        Authorization: process.env.OPENNODE_KEY,
        'Content-Type': 'application/json'
    }
});

const openNodeApiV2 = axios.create({
    baseURL: 'https://api.opennode.co/v2',
    timeout: 15000,
    headers: {
        Authorization: process.env.OPENNODE_KEY,
        'Content-Type': 'application/json'
    }
});

exports.createInvoice = ({ orderId, amount, notify }) => {
    try {
        const description = `Lightning gift for ${amount} sats` + (notify ? ` [${notify}]` : '');

        return openNodeApi.post('/charges', {
            order_id: orderId,
            amount,
            description,
            callback_url: `${process.env.SERVICE_URL}/webhooks/create`
        });
    } catch (error) {
        const newError = error;
        newError.message = 'OpenNode Error';
        throw newError;
    }
};

exports.showCurrencies = () => {
    try {
        return openNodeApi.get('/currencies');
    } catch (error) {
        const newError = error;
        newError.message = 'OpenNode Error';
        throw newError;
    }
};

exports.getInvoiceStatus = chargeId => {
    try {
        return openNodeApi.get(`/charge/${chargeId}`);
    } catch (error) {
        const newError = error;
        newError.message = 'OpenNode Error';
        throw newError;
    }
};

exports.redeemGift = ({ amount, invoice }) => {
    try {
        return openNodeApiV2.post('/withdrawals', {
            type: 'ln',
            amount,
            address: invoice,
            callback_url: `${process.env.SERVICE_URL}/webhooks/redeem`
        });
    } catch (error) {
        const newError = error;
        newError.message = 'OpenNode Error';
        throw newError;
    }
};

exports.checkRedeemStatus = withdrawalId => {
    try {
        return openNodeApi.get(`/withdrawal/${withdrawalId}`);
    } catch (error) {
        const newError = error;
        newError.message = 'OpenNode Error';
        throw newError;
    }
};

exports.notifyRedeem = data => {
    if (!data.notify) {
        return;
    }
    try {
        axios.post(data.notify, { id: data.id, amount: data.amount, spent: true }, { timeout: 2000 });
    } catch (error) {
        throw error;
    }
};
