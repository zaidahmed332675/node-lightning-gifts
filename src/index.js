// NPM Dependencies
const express = require('express');
const cryptoRandomString = require('crypto-random-string');
const rateLimit = require('express-rate-limit');
const _ = require('lodash');
const Sentry = require('@sentry/node');

// Module Dependencies
const {
    showCurrencies,
    createInvoice,
    getInvoiceStatus,
    redeemGift,
    checkRedeemStatus
} = require('./controllers');
const {
    getGiftInfo,
    createGift,
    giftWithdrawSuccess,
    giftWithdrawTry,
    giftWithdrawFail,
    updateGiftChargeStatus
} = require('./models');
const { getInvoiceAmount, buildLNURL, trackEvent } = require('./utils');

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50
});

const checkLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200
});

const app = express();

if (process.env.NODE_ENV === 'production') {
    app.enable('trust proxy');
    Sentry.init({ dsn: process.env.SENTRY_KEY });
    app.use(Sentry.Handlers.requestHandler());
}

app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/currency', (req, res) => {
    showCurrencies().then(response => {
        res.json(response.data);
    });
});

app.post('/create', apiLimiter, (req, res, next) => {
    const { amount, senderName = null, senderMessage = null, notify = null, verifyCode = null } = req.body;
    const orderId = cryptoRandomString({ length: 48 });

    if (!Number.isInteger(amount)) {
        res.statusCode = 400;
        next(new Error('GIFT_AMOUNT_NOT_WHOLE_NUMBER'));
    } else if (amount < 100) {
        res.statusCode = 400;
        next(new Error('GIFT_AMOUNT_UNDER_100'));
    } else if (amount > 500000) {
        res.statusCode = 400;
        next(new Error('GIFT_AMOUNT_OVER_500K'));
    } else if (!_.isNil(senderName) && !_.isString(senderName)) {
        res.statusCode = 400;
        next(new Error('SENDER_NAME_NOT_STRING'));
    } else if (!_.isNil(senderName) && senderName.length > 15) {
        res.statusCode = 400;
        next(new Error('SENDER_NAME_BAD_LENGTH'));
    } else if (!_.isNil(senderMessage) && !_.isString(senderMessage)) {
        res.statusCode = 400;
        next(new Error('SENDER_MESSAGE_NOT_STRING'));
    } else if (!_.isNil(senderMessage) && senderMessage.length > 100) {
        res.statusCode = 400;
        next(new Error('SENDER_MESSAGE_BAD_LENGTH'));
    } else if (!_.isNil(verifyCode) && !_.isNumber(verifyCode)) {
        res.statusCode = 400;
        next(new Error('VERIFY_CODE_NOT_NUMBER'));
    } else if (!_.isNil(verifyCode) && verifyCode.toString().length !== 4) {
        res.statusCode = 400;
        next(new Error('VERIFY_CODE_BAD_LENGTH'));
    } else {
        createInvoice({ orderId, amount, notify })
            .then(response => {
                const {
                    id: chargeId, order_id: orderId, status, lightning_invoice: lightningInvoice, amount
                } = response.data.data;

                try {
                    createGift({
                        orderId,
                        amount,
                        chargeId,
                        chargeStatus: status,
                        chargeInvoice: lightningInvoice.payreq,
                        notify,
                        senderName,
                        senderMessage,
                        verifyCode,
                    }).then(gift => {
                        trackEvent(req, 'create try', { orderId });

                        res.json({
                            orderId,
                            chargeId,
                            status,
                            lightningInvoice,
                            amount,
                            notify,
                            lnurl: buildLNURL(orderId),
                            senderName,
                            senderMessage,
                        });
                    });
                } catch (error) {
                    next(error);
                }
            })
            .catch(error => {
                next(error);
            });
    }
});

app.post('/webhooks/create', (req, res, next) => {
    const { id: chargeId, status, order_id: orderId } = req.body;

    if (status === 'paid') {
        getInvoiceStatus(chargeId)
            .then(response => {
                const { status: chargeStatus, price } = response.data.data;
                try {
                    updateGiftChargeStatus({ orderId, chargeStatus });

                    trackEvent(req, 'create success', { orderId, amount: price });

                    res.sendStatus(200)
                } catch (error) {
                    next(error);
                }
            })
            .catch(error => {
                next(error);
            });
    } else {
        res.sendStatus(200)
    }
});

app.get('/status/:chargeId', checkLimiter, (req, res, next) => {
    const { chargeId } = req.params;

    trackEvent(req, 'charge query', { chargeId });

    try {
        getInvoiceStatus(chargeId)
            .then(response => {
                const { status } = response.data.data;

                res.json({ status });
            })
            .catch(error => {
                next(error);
            });
    } catch (error) {
        next(error);
    }
});

app.get('/gift/:orderId', checkLimiter, (req, res, next) => {
    const { orderId } = req.params;
    const { verifyCode: verifyCodeTry = null  } = req.query;

    trackEvent(req, 'gift query', { orderId });

    try {
        getGiftInfo(orderId).then(response => {
            if (_.isNil(response)) {
                res.statusCode = 404;
                next(new Error('GIFT_NOT_FOUND'));
            } else {
                const { amount, spent, chargeStatus, verifyCode } = response;

                if (!_.isNil(verifyCode) && Number(verifyCodeTry) !== verifyCode) {
                    res.json({ amount, chargeStatus, spent, orderId, verifyCodeRequired: true });
                } else {
                    res.json({ ...response, orderId, lnurl: buildLNURL(orderId) });
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/redeem/:orderId', apiLimiter, (req, res, next) => {
    const { orderId } = req.params;

    getGiftInfo(orderId)
        .then(response => {
            if (_.isNil(response)) {
                res.statusCode = 404;
                next(new Error('GIFT_NOT_FOUND'));
            } else {
                const { amount, spent, chargeStatus, verifyCode } = response;
                const { invoice, verifyCode: verifyCodeTry  } = req.body;
                const invoiceAmount = getInvoiceAmount(invoice);

                if (invoiceAmount !== amount) {
                    res.statusCode = 400;
                    next(new Error('BAD_INVOICE_AMOUNT'));
                } else if (spent === 'pending') {
                    res.statusCode = 400;
                    next(new Error('GIFT_REDEEM_PENDING'));
                } else if (spent) {
                    res.statusCode = 400;
                    next(new Error('GIFT_SPENT'));
                } else if (chargeStatus !== 'paid') {
                    res.statusCode = 400;
                    next(new Error('GIFT_INVOICE_UNPAID'));
                } else if (!_.isNil(verifyCode) && Number(verifyCodeTry) !== verifyCode) {
                    res.statusCode = 400;
                    next(new Error('BAD_VERIFY_CODE'));
                } else {
                    redeemGift({ amount, invoice })
                        .then(response => {
                            const { id: withdrawalId, reference } = response.data.data;

                            try {
                                giftWithdrawTry({
                                    orderId,
                                    withdrawalId,
                                    reference
                                });
                            } catch (error) {
                                next(error);
                            }

                            trackEvent(req, 'invoice redeem try', { orderId });

                            res.json({ withdrawalId });
                        })
                        .catch(error => {
                            next(error);
                        });
                }
            }
        })
        .catch(error => {
            next(error);
        });
});

app.get('/lnurl/:orderId', apiLimiter, (req, res, next) => {
        const { orderId } = req.params;
        const { pr } = req.query;

        getGiftInfo(orderId)
            .then(response => {
                const { amount, spent, chargeStatus } = response;

                if (_.isNil(response)) {
                    res.statusCode = 404;
                    next(new Error('GIFT_NOT_FOUND'));
                } else if (spent === 'pending') {
                    res.statusCode = 400;
                    next(new Error('GIFT_REDEEM_PENDING'));
                } else if (spent) {
                    res.statusCode = 400;
                    next(new Error('GIFT_SPENT'));
                } else if (chargeStatus !== 'paid') {
                    res.statusCode = 400;
                    next(new Error('GIFT_INVOICE_UNPAID'));
                } else if (_.isNil(pr)){
                    // return first lnurl response
                    res.json({
                        status: 'OK',
                        callback: `${process.env.SERVICE_URL}/lnurl/${orderId}`,
                        k1: orderId,
                        maxWithdrawable: amount * 1000,
                        minWithdrawable: amount * 1000,
                        defaultDescription: `lightning.gifts redeem ${orderId}`,
                        tag: 'withdrawRequest'
                    });
                } else {
                    // if pr exists we will redeem the gift already
                    const invoiceAmount = pr ? getInvoiceAmount(pr) : null;

                    if (invoiceAmount !== amount) {
                        res.statusCode = 400;
                        next(new Error('BAD_INVOICE_AMOUNT'));
                    } else {
                        redeemGift({ amount, invoice: pr })
                            .then(response => {
                                const { id: withdrawalId, reference } = response.data.data;

                                try {
                                    giftWithdrawTry({
                                        orderId,
                                        withdrawalId,
                                        reference
                                    });
                                } catch (error) {
                                    next(error);
                                }

                                trackEvent(req, 'lnurl redeem try', { orderId });

                                res.json({ status: 'OK' });
                            })
                            .catch(error => {
                                next(error);
                            });
                    }
                }
            })
            .catch(error => {
                next(error);
            });
    },
    // lnurl error handling
    (error, req, res, next) => {
        const statusCode = _.defaultTo(_.defaultTo(error.statusCode, res.statusCode), 500);
        console.log('lnurl error:', error);
        res.status(statusCode).send({
            status: 'ERROR',
            reason: error.message
        });
    }
);

app.post('/redeemStatus/:withdrawalId', checkLimiter, (req, res, next) => {
    const { withdrawalId } = req.params;
    // const { orderId } = req.body;
    trackEvent(req, 'redeem query', { withdrawalId });

    checkRedeemStatus(withdrawalId)
        .then(response => {
            const { reference, status } = response.data.data;

            res.json({ reference, status });
        })
        .catch(error => {
            next(new Error('WITHDRAWAL_FAILED'));
        });
});

app.post('/webhooks/redeem', (req, res, next) => {
    const {
        status, id: withdrawalId, fee, error, amount
    } = req.body;

    if (status === 'confirmed') {
        try {
            giftWithdrawSuccess({ withdrawalId, fee });

            trackEvent(req, 'redeem success', { withdrawalId, amount });

            res.sendStatus(200)
        } catch (error) {
            next(error);
        }
    } else if (_.includes(['error', 'failed'], status)) {
        try {
            giftWithdrawFail({ withdrawalId, error });

            res.sendStatus(200)
        } catch (error) {
            next(error);
        }
    } else {
        next();
    }

});

if (process.env.NODE_ENV === 'production') {
    app.use(Sentry.Handlers.errorHandler());
}

// error handling
app.use((error, req, res, next) => {
    const statusCode =
        _.defaultTo(_.defaultTo(error.statusCode, _.get(error, 'response.status')), _.defaultTo(res.statusCode, 500));
    // console.log('req.ip', req.ip);
    // console.log('x-forwarded-for', req.headers["x-forwarded-for"]);
    trackEvent(req, 'exception', { message: error.message });

    res.status(statusCode).send({
        statusCode,
        message: error.message
    });
});

// listen for requests :)
app.set('port', process.env.PORT || 8080);
const server = app.listen(app.get('port'), () => {
    console.log(`Your app is listening on port ${server.address().port}`);
});
