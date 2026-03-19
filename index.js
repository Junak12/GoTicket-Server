import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import Stripe from "stripe";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET);
const app = express();

const port = process.env.Port;

//pauljunak_db_user
//d40h7Rvcjnqh6MkJ

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("GoTicket is running");
});

const uri = process.env.MONGODB_URI;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    await client.connect();
    const db = client.db("goTicket");
    const userCollection = db.collection("user");
    const ticketsCollection = db.collection("tickets");
    const bookingsCollection = db.collection("bookings");
    const paymentsCollection = db.collection("payments");

    // post user
    app.post("/user", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const isExist = await userCollection.findOne(query);
      if (isExist) {
        return res.send({ message: "User already exists", inserted: false });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    //post ticket
    app.post("/tickets", async (req, res) => {
      const tickets = req.body;
      const result = await ticketsCollection.insertMany(tickets);
      res.send(result);
    });

    //get Ticket
    app.get("/getTicket", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 6;
      const skip = (page - 1) * limit;
      const tickets = await ticketsCollection
        .find({
          status: "approved",
        })
        .skip(skip)
        .limit(limit)
        .toArray();
      //const tickets = await ticketsCollection.find({}).toArray();
      const totalTickets = await ticketsCollection.countDocuments({
        status: "approved",
      });
      res.send({
        tickets,
        totalPages: Math.ceil(totalTickets / limit),
        currentPage: page,
      });
    });

    //get ticket by search
    app.get("/getTicket/search", async (req, res) => {
      const { from, to, transport } = req.query;
      const query = {
        status: "approved",
      };
      if (from) {
        query.from = from;
      }
      if (to) {
        query.to = to;
      }
      if (transport) {
        query.transportType = transport;
      }
      const result = await ticketsCollection.find(query).toArray();
      res.send(result);
    });

    //getting ticket on the basis of id
    app.get("/tickets/:id", async (req, res) => {
      const id = req.params.id;
      const query = {
        _id: new ObjectId(id),
      };
      const result = await ticketsCollection.findOne(query);
      res.send(result);
    });

    //create post api for payment wih stripe
    app.post("/create-checkout-session", async (req, res) => {
      const { totalPrice, email, vendorName, ticketId, seats } = req.body;
      //console.log("BODY:", req.body);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: vendorName,
              },
              unit_amount: totalPrice * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: email,
        mode: "payment",
        metadata: {
          ticketId: ticketId,
          seats: seats.join(","),
          totalTickets: seats.length.toString(),
          totalPrice: totalPrice.toString(),
          email: email,
        },
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    //api after payment done to store in booking collection and payment collection and also update the ticket collectio

app.post("/verify-payment", async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send({
        success: false,
        message: "Payment not completed",
      });
    }

    const isExist = await paymentsCollection.findOne({
      transactionId: session.payment_intent,
    });

    if (isExist) {
      const booking = await bookingsCollection.findOne({
        _id: isExist.bookingId,
      });

      const ticket = await ticketsCollection.findOne({
        _id: booking?.ticketId,
      });

      return res.send({
        success: true,
        booking: {
          vendorName: ticket?.title || "Unknown",
          seats: booking?.seats || [],
          totalTickets: booking?.seats?.length || 0,
          totalPrice: booking?.totalPrice || 0,
        },
      });
    }

    const ticketId = session.metadata?.ticketId;
    const seats = session.metadata?.seats?.split(",") || [];
    const totalPrice = parseFloat(session.metadata?.totalPrice) || 0;

    if (!ticketId || seats.length === 0) {
      return res.status(400).send({
        success: false,
        message: "Invalid metadata",
      });
    }

    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(ticketId),
    });

    if (!ticket) {
      return res.status(404).send({
        success: false,
        message: "Ticket not found",
      });
    }

    const bookingResult = await bookingsCollection.insertOne({
      email: session.customer_email,
      ticketId: new ObjectId(ticketId),
      seats,
      totalPrice,
      createdAt: new Date(),
    });

    await paymentsCollection.insertOne({
      email: session.customer_email,
      ticketId: new ObjectId(ticketId),
      bookingId: bookingResult.insertedId,
      amount: session.amount_total / 100,
      paymentMethod: "stripe",
      transactionId: session.payment_intent,
      status: "success",
      vendorEmail: ticket.vendorEmail || "unknown",
      createdAt: new Date(),
    });

await ticketsCollection.updateOne(
  { _id: new ObjectId(ticketId) },
  {
    $inc: {
      quantity: -seats.length,
      bookingCount: seats.length, 
    },
    $push: { bookedSeats: { $each: seats } },
  },
);
    res.send({
      success: true,
      booking: {
        vendorName: ticket.title,
        seats,
        totalTickets: seats.length,
        totalPrice,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({
      success: false,
      message: "Server error",
    });
  }
});

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
