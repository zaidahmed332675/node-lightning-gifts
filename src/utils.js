// NPM Dependencies
const bech32 = require('bech32');
const _ = require('lodash');
const Mixpanel = require('mixpanel');
const crypto = require('crypto');

const mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN);

exports.getInvoiceAmount = invoice => {
    const cleanInvoice = invoice.toLowerCase();

    let removedNetwork;
    if (_.startsWith(cleanInvoice, 'lnbc')) {
        removedNetwork = cleanInvoice.replace('lnbc', '');
    } else if (_.startsWith(cleanInvoice, 'lntb')) {
        removedNetwork = cleanInvoice.replace('lntb', '');
    } else if (_.startsWith(cleanInvoice, 'lnbcrt')) {
        removedNetwork = cleanInvoice.replace('lnbcrt', '');
    } else {
        throw 'Not a BOLT-11 invoice';
    }

    const multiplier = removedNetwork.match(/[a-zA-Z]/).pop();

    let invoiceAmount;
    if (multiplier === 'n') {
        const multiplierPosition = removedNetwork.indexOf('n');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition - 1);
    } else if (multiplier === 'u') {
        const multiplierPosition = removedNetwork.indexOf('u');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition);
        invoiceAmount += '00';
    } else if (multiplier === 'm') {
        const multiplierPosition = removedNetwork.indexOf('m');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition);
        invoiceAmount += '00000';
    } else {
        throw 'Something went wrong with BOLT-11 decoding';
    }

    const amountAsNumber = Number(invoiceAmount);
    return amountAsNumber;
};

exports.buildLNURL = orderId =>
    bech32.encode(
        'lnurl',
        bech32.toWords(Buffer.from(`${process.env.SERVICE_URL}/lnurl/${orderId}`)),
        1500
    );

exports.trackEvent = (req, eventName, params) => {
    const ip = process.env.NODE_ENV === 'production' ? req.ip : req.headers["x-forwarded-for"];
    const id = crypto.createHash('md5').update(_.toString(ip)).digest("hex");
    const route = req.baseUrl || req.path;

    mixpanel.track(eventName, {
        distinct_id: id,
        ip,
        route,
        ...params
    });
};
