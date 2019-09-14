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
    giftWithdrawFail
} = require('./models');
const { getInvoiceAmount, buildLNURL } = require('./utils');

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50
});

const app = express();

if (process.env.NODE_ENV === 'production') {
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
    const { amount, notify = null } = req.body;
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
    } else {
        createInvoice({ orderId, amount, notify })
            .then(response => {
                const { id: chargeId, status, lightning_invoice: lightningInvoice, amount } = response.data.data;
                res.json({
                    orderId,
                    chargeId,
                    status,
                    lightningInvoice,
                    amount,
                    lnurl: buildLNURL(orderId)
                });
            })
            .catch(error => {
                next(error);
            });
    }
});

app.post('/webhooks/create', (req, res, next) => {
    const {
        id: chargeId,
        status,
        order_id: orderId,
        price,
        description
    } = req.body;

    const notifymatch = description.match(/\[(http[^\]]+)]/);
    const notify = notifymatch ? notifymatch[1] : null;

    if (status === 'paid') {
        getInvoiceStatus(chargeId)
            .then(response => {
                const { lightning_invoice } = response.data.data;

                try {
                    createGift({
                        orderId,
                        chargeId: chargeId,
                        amount: price,
                        chargeInvoice: lightning_invoice.payreq,
                        notify
                    });

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

app.get('/status/:chargeId', (req, res, next) => {
    const { chargeId } = req.params;

    getInvoiceStatus(chargeId)
        .then(response => {
            const { status } = response.data.data;

            res.json({ status });
        })
        .catch(error => {
            next(error);
        });
});

app.get('/gift/:orderId', apiLimiter, (req, res, next) => {
    const { orderId } = req.params;

    try {
        getGiftInfo(orderId).then(response => {
            if (!_.isNil(response)) {
                res.json({ ...response, orderId, lnurl: buildLNURL(orderId) });
            } else {
                res.status(404).send({
                    message: 'notFound'
                });
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
                const { amount, spent } = response;
                const { invoice } = req.body;
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

        getGiftInfo(orderId)
            .then(response => {
                if (_.isNil(response)) {
                    res.statusCode = 404;
                    next(new Error('GIFT_NOT_FOUND'));
                } else {
                    const { amount, spent } = response;
                    const { pr } = req.query; // if this exists we will redeem the gift already
                    const invoiceAmount = pr ? getInvoiceAmount(pr) : null;

                    if (pr && invoiceAmount !== amount /* only checked when redeeming */) {
                        res.statusCode = 400;
                        next(new Error('BAD_INVOICE_AMOUNT'));
                    } else if (spent === 'pending') {
                        res.statusCode = 400;
                        next(new Error('GIFT_REDEEM_PENDING'));
                    } else if (spent) {
                        res.statusCode = 400;
                        next(new Error('GIFT_SPENT'));
                    } else if (pr) {
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

                                res.json({ status: 'OK' });
                            })
                            .catch(error => {
                                next(error);
                            });
                    } else {
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
        console.log('lnurl error:', error.response);
        res.status(statusCode).send({
            status: 'ERROR',
            reason: error.message
        });
    }
);

app.post('/redeemStatus/:withdrawalId', (req, res, next) => {
    const { withdrawalId } = req.params;
    // const { orderId } = req.body;

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
        status, id: withdrawalId, fee, error
    } = req.body;

    if (status === 'confirmed') {
        try {
            giftWithdrawSuccess({ withdrawalId, fee });

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
    const statusCode = _.defaultTo(_.defaultTo(error.statusCode, res.statusCode), 500);
    console.log('error:', error);
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
