require('isomorphic-fetch');
const next = require('next')
  , dotenv = require('dotenv')
  , Shopify = require('shopify-api-node')
  , express = require('express')
  , compression = require('compression')
  , mobxReact = require('mobx-react')
  , Client = require('shopify-buy')
  , Axios = require('axios')
  , stripe = require('stripe')
  , { get, omit, isEmpty } = require('lodash')
  , Sentry = require('@sentry/node')
  ;

dotenv.config();
const stripeClient = stripe(process.env.STRIPE_API_KEY);

const port = parseInt(process.env.PORT, 10) || 3000
  , dev = process.env.NODE_ENV !== 'production'
  , app = next({dev, dir: 'src'})
  , handle = app.getRequestHandler()
  ;

const {
  RECHARGE_API_KEY,
  SHOPIFY_API_KEY,
  SHOPIFY_STOREFRONT_KEY,
  SHOPIFY_DOMAIN,
  SHOPIFY_PASSWORD,
  SENTRY_DSN,
  SHIP_ENGINE_API_KEY,
} = process.env;

const storefrontClient = Client.buildClient({
  storefrontAccessToken: SHOPIFY_STOREFRONT_KEY,
  domain: SHOPIFY_DOMAIN,
});

const adminClient = Axios.create({
  baseURL: `https://${SHOPIFY_API_KEY}:${SHOPIFY_PASSWORD}@${SHOPIFY_DOMAIN}/admin/api/2019-07`,
  timeout: 2900000,
  headers: {
    'Accept': 'application/json; charset=utf-8;',
    'Content-Type': 'application/json',
  },
});

const adminAPI = new Shopify({
  shopName: SHOPIFY_DOMAIN,
  apiKey: SHOPIFY_API_KEY,
  apiVersion: '2019-07',
  password: SHOPIFY_PASSWORD,
});

const rechargeClient = Axios.create({
  baseURL: 'https://api.rechargeapps.com/',
  timeout: 2900000,
  headers: {
    'Accept': 'application/json; charset=utf-8;',
    'Content-Type': 'application/json',
    'X-Recharge-Access-Token': RECHARGE_API_KEY,
  }
});

const shipEngineClient = Axios.create({
  baseURL: 'https://api.shipengine.com/',
  timeout: 2900000,
  headers: {
    'Accept': 'application/json; charset=utf-8;',
    'Content-Type': 'application/json',
    'API-Key': SHIP_ENGINE_API_KEY,
  }
});

mobxReact.useStaticRendering(true);

// Sentry Integration
Sentry.init({ dsn: SENTRY_DSN });

app.prepare().then(() => {
  const server = express();
  server.use(compression());
  server.use(express.json()); // for parsing application/json
  server.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

  server.get('/products/', async (req, res) => {
    const response = await storefrontClient.product.fetchAll();
    return res.send(JSON.stringify(response));
  });

  /* FETCH PRODUCTS */

  server.get('/recharge-products/', async (req, res) => {
    const response = await rechargeClient.get('/products?collection_id=212146');
    return res.send(JSON.stringify(response.data));
  });

  server.get('/shopify-menu-products/', async (req, res) => {
    const response = await adminClient.get('/products.json?product_type=recipe');
    return res.send(JSON.stringify(response.data));
  })

  /* END FETCH PRODUCTS */

  /* GET CUSTOMER INFO */

  server.get('/recharge-customers/:id', async (req, res) => {
    const response = await rechargeClient.get(`customers?shopify_customer_id=${req.params.id}`);
    return res.end(JSON.stringify(response.data));
  });

  server.get('/customers/:id/addresses/', async (req, res) => {
    const response = await adminClient.get(`customers/${req.params.id}/addresses.json/`);
    return res.end(JSON.stringify(response.data));
  });

  server.get('/recharge-customers/:stripe_id/payment_sources', async (req, res) => {
    const response = await stripeClient.customers.retrieve(req.params.stripe_id);
    return res.end(JSON.stringify(response));
  });

  /* END GET CUSTOMER INFO */

  /* UPDATE CUSTOMERS ADDRESS */

  server.put('/customers/:customer_id/addresses/:address_id', async (req, res) => {
    try {
      const response = await adminClient.put(`/customers/${req.params.customer_id}/addresses/${req.params.address_id}.json`, req.body);
      return res.send(JSON.stringify(response.data));
    }
    catch (e) {
      return res.status(400).send(e.response.data.errors);
    }
  });

  server.put('/customers', async (req, res) => {
    const { recharge_id, shopify_id } = req.query;

    // Update name, email, phone, password in Shopify details
    try {
      const { first_name, last_name, email, billing_phone, password, password_confirmation } = req.body;
      const shopifyCustomerInfo = {
        first_name,
        last_name,
        email,
        phone: billing_phone,
      };

      if (!isEmpty(password)) {
        shopifyCustomerInfo.password = password;
        shopifyCustomerInfo.password_confirmation = password_confirmation;
      }

      await adminAPI.customer.update(shopify_id, shopifyCustomerInfo);
    }
    catch (e) {
      // Sentry capture exception
      Sentry.captureException(e);
      return res.status(500).end(JSON.stringify({message: 'Something went wrong!'}));
    }

    // Update Recharge
    try {
      const response = await rechargeClient.put(`customers/${recharge_id}/`, req.body);
      return res.send(JSON.stringify(response.data));
    }
    catch (e) {
      // Sentry capture exception
      Sentry.captureException(e);
      return res.status(500).end(JSON.stringify({message: 'Something went wrong!'}));
    }
  });

  /* UPDATE CUSTOMERS ADDRESS */

  /* UPDATE CUSTOMER PAYMENT INFO */

  server.put('/customers/:stripe_id/payment-info', async (req, res) => {
    try {
      const { params: { stripe_id }, body: { token, email } } = req
        , source = await stripeClient.sources.create({type: 'card', token: token, owner: {email}})
        ;

      await stripeClient.customers.createSource(stripe_id, {source: source.id});
      await stripeClient.customers.update(stripe_id, {default_source: source.id});

      return res.status(204).send('Success');
    }
    catch (e) {
      console.error(e)
      return res.status(400).json(JSON.stringify(e));
    }
  });

  /* END UPDATE CUSTOMER PAYMENT INFO */

  /* CREATE ORDER */

  server.post('/recharge-customer-info/', async (req, res) => {
    const { shopifyCustomerInfo, rechargeCustomerInfo, metafieldData } = req.body;

    let id = ''
      , rechargeCustomerResponse = {}
      ;

    // Check if there is an existing shopify customer or create a new one
    try {
      // ADD metafields data
      shopifyCustomerInfo.metafields = metafieldData;

      const response = await adminAPI.customer.create(shopifyCustomerInfo);
      id = response.id;
    }
    catch (e) {
      const shopifyCustomers = await adminAPI.customer.list({email: shopifyCustomerInfo.email});
      if (shopifyCustomers.length) {
        id = shopifyCustomers[0].id;
        // try to update customer's info if one if found
        try {
          if (!shopifyCustomers[0].addresses.length) {
            await adminAPI.customerAddress.create(id, shopifyCustomerInfo.addresses[0]);
          }
          await adminAPI.customer.update(id, omit(shopifyCustomerInfo, ['addresses', 'email']));
        }
        catch (e) {
        console.log('second catch');
        console.log(e);
          // Sentry capture exception
          Sentry.captureException(e);
          return res.status(500).end(JSON.stringify({message: 'Something went wrong!'}));
        }
      }
      // otherwise throw an error as it was an invalid input
      else {
        // Sentry capture exception
        console.log('third catch');
        console.log(e);
        Sentry.captureException(e);
        return res.status(500).end(JSON.stringify({message: 'Something went wrong!'}));
      }
    }

    // Check if there is an existing recharge customer or create a new one
    try {
      const rechargeSubmitData = {...rechargeCustomerInfo, shopify_customer_id: id};
      rechargeCustomerResponse = await rechargeClient.post('customers', rechargeSubmitData);
    }
    catch (e) {
      console.log('fourth catch');
      console.log(e);
      const rechargeCustomers = await rechargeClient.get(`customers?shopify_customer_id=${id}`);
      if (get(rechargeCustomers, 'data.customers[0]')) {
        rechargeCustomerResponse = {data: {customer: {id: rechargeCustomers.data.customers[0].id } } };
      }
      else {
        console.log('fifth catch');
        console.log(e);
        // Sentry capture exception
        Sentry.captureException(e);
        return res.status(500).end(JSON.stringify({message: 'Something went wrong!'}));
      }
    }

    return res.end(JSON.stringify({id, rechargeCustomerResponse: rechargeCustomerResponse.data}));
  });

  server.post('/checkout/', async (req, res) => {
    try {
      const { rechargeCheckoutData, stripeToken } = req.body
        , rechargeCheckoutResponse = await rechargeClient.post('checkouts', rechargeCheckoutData)
        , { checkout: { token } } = rechargeCheckoutResponse.data
        , shippingRates = await rechargeClient.get(`checkouts/${token}/shipping_rates/`)
        ;

      try {
        await rechargeClient.put(`checkouts/${token}/`, {
          checkout: {
            shipping_line: {
              handle: get(shippingRates, 'data.shipping_rates[0].handle', 'shopify-Free%20Shipping-0.00'),
            },
          },
        });
      }
      catch (e) {
        console.error(e.response.data.errors)
        // Sentry capture exception
        Sentry.captureException(e);
      }

      try {
        await rechargeClient.post(`checkouts/${token}/charge/`,{
          checkout_charge: { payment_processor: 'stripe', payment_token: stripeToken },
        });
      }
      catch (e) {
        console.error(e.response.data.errors)
        // Sentry capture exception
        Sentry.captureException(e);
      }

      res.status(200).json({message: 'Success!'});
    }
    catch (e) {
      console.error(get(e.response.data.errors, 'line_items[0].product_id'));
      console.error(e.response.data.errors)
      // Sentry capture exception
      Sentry.captureException(e);
      res.status(400).json(e);
    }
  });

  // END CREATE ORDER

  // GET METAFIELDS FOR CUSTOMER

  server.get(`/customers/:customer_id/metafields`, async (req, res) => {
    try {
      const response = await adminClient.get(`/customers/${req.params.customer_id}/metafields.json`);
      return res.send(JSON.stringify(response.data));
    }
    catch(e) {
      console.log(e.message);
      return res.status(500).end(JSON.stringify({message: e.message}));
    }
  });
  
  // END GET METAFIELDS

  // UPDATE CUSTOMER METAFIELD BY ID

  server.put(`/customers/:customer_id/metafields/:metafield_id`, async (req, res) => {
    try {
      const response = await adminClient.put(`/customers/${req.params.customer_id}/metafields/${req.params.metafield_id}.json`, req.body);
      return res.send(JSON.stringify(response.data));
    }
    catch(e) {
      return res.status(500).end(JSON.stringify({message: e.message}));
    }
  });

  // END UPDATE CUSTOMER METAFIELD
  

  // FETCH ADDRESSES

  server.get('/recharge-addresses', async (req, res) => {
    const response = await rechargeClient.get(`customers/${req.query.customer_id}/addresses`);
    return res.json(response.data);
  });

  // END FETCH ADDRESSES

  // UPDATE SHIPPING ADDRESS

  server.put('/recharge-addresses/:id', async (req, res) => {
    try {
      const { data } = await rechargeClient.put(`/addresses/${req.params.id}`, req.body);
      return res.json(data);
    }
    catch (e) {
      res.json({message: e.response.data.errors});
    }
  });

  // END UPDATE SHIPPING ADDRESS

  // FETCH CHARGES

  server.get('/recharge-queued-charges/', async (req, res) => {
    const response = await rechargeClient.get(`charges?status=QUEUED&customer_id=${req.query.customer_id}`);
    return res.end(JSON.stringify(response.data));
  });

  server.get('/recharge-processed-charges/', async (req, res) => {
    const response = await rechargeClient.get(`charges?status=SUCCESS&customer_id=${req.query.customer_id}`);
    return res.end(JSON.stringify(response.data));
  });

  // END FETCH CHARGES

  // CHANGE ORDER DATE

  server.post('/change-order-date/:orderId', async (req, res) => {
    const response = await rechargeClient.post(`/charges/${req.params.orderId}/change_next_charge_date`, req.body);
    return res.send(JSON.stringify(response.data))
  });

  // END CHANGE ORDER DATE

  // ADD DISCOUNT TO ADDRESS

    server.post('/add-new-discount/:addressId', async (req, res) => {
      try {
        const response = await rechargeClient.post(`/addresses/${req.params.addressId}/apply_discount`, req.body);
        return res.send(JSON.stringify(response.data));
      }
      catch (e) {
        console.log(e);
        res.json({message: e.response.data.errors});
      }
    });

  // END ADD DISCOUNT TO ADDRESS

  // SUBSCRIPTIONS

  server.get('/subscriptions/:id', async (req, res) => {
    const response = await rechargeClient.get(`/subscriptions/${req.params.id}`);
    return res.send(JSON.stringify(response.data))
  });

  server.put('/subscriptions/:id', async (req, res) => {
    try {
      const response = await rechargeClient.put(`/subscriptions/${req.params.id}`, req.body);
      return res.send(JSON.stringify(response.data))
    }
    catch (e) {
      res.json({message: e.response.data.errors});
    }
  });

  server.delete('/subscriptions/:id', async (req, res) => {
    try {
      const response = await rechargeClient.delete(`/subscriptions/${req.params.id}`, req.body);
      return res.send(JSON.stringify(response.data))
    }
    catch (e) {
      res.json({message: e.response.data.errors});
    }
  });

  server.post('/subscriptions', async (req, res) => {
    try {
      const response = await rechargeClient.post('/subscriptions', req.body);
      return res.send(JSON.stringify(response.data))
    }
    catch (e) {
      res.json({message: e.response.data.errors});
    }
  });

  // END UPDATE SUBSCRIPTION

  // ADD ONE-TIME PRODUCT TO ORDER

  server.post('/onetimes/address/:address_id', async (req, res) => {
    try {
      const response = await rechargeClient.post(`/onetimes/address/${req.params.address_id}`, req.body);
      return res.end(JSON.stringify(response.data));
    }
    catch (e) {
      res.json({message: e.response.data.errors});
    }
  });

  server.delete('/onetimes/:id', async (req, res) => {
    try {
      await rechargeClient.delete(`/onetimes/${req.params.id}`);
      return res.end('deleted');
    }
    catch (e) {
      console.error(e)
      res.status(500).json({message: e.message});
    }
  });

  // END ADD ONE-TIME PRODUCT TO ORDER

  // DISCOUNTS //

  server.get('/discounts/:code', async (req, res) => {
    try {
      const response = await rechargeClient.get(`/discounts?discount_code=${req.params.code}`);
      return res.send(JSON.stringify(response.data));
    }
    catch (e) {
      res.status(400).json(e);
    }
  });

  // END METAFIELDS


  // SHOPIFY FULFILLMENT INFO

  server.get('/orders/:id/', async (req, res) => {
    try {
      const response = await adminClient.get(`orders/${req.params.id}/fulfillments.json/`);
      return res.end(JSON.stringify(response.data));
    }
    catch (e) {
      console.error(e)
      res.status(400).json(e);
    }
  });

  // END SHOPIFY FULFILLMENT INFO


  // TODO why is this getting the incorrect tracking number?
  // SHIP ENGINE TRACKING

  // server.get('/tracking/:id', async (req, res) => {
  //   try {
  //     const response = await shipEngineClient.get(`/v1/tracking?carrier_code=fedex&tracking_number=${req.params.id}`);
  //     return res.send(JSON.stringify(response.data));
  //   }
  //   catch (e) {
  //     console.error(e)
  //     res.status(400).json(e);
  //   }
  // });

  // END SHIP ENGINE TRACKING

  // GENERIC

  server.get('*', (req, res) => {
    return handle(req, res);
  });

  server.listen(port, async () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
