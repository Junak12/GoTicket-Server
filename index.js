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
    const vendorCollection = db.collection("vendor");

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
      const result = await ticketsCollection.insertOne(tickets);
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
    app.post("/book-ticket", async (req, res) => {
      try {
        const { ticketId, email, seats, totalPrice, selectedPerks } = req.body;
        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(ticketId),
        });

        if (!ticket) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        if (seats.length > ticket.quantity) {
          return res.status(400).send({
            success: false,
            message: "Not enough tickets available",
          });
        }

        const bookingData = {
          email,
          ticketId: new ObjectId(ticketId),
          ticketTitle: ticket.title,
          ticketImage: ticket.image,
          from: ticket.from,
          to: ticket.to,
          departureTime: ticket.departureDateTime,
          unitPrice: ticket.price,
          seats,
          totalPrice,
          selectedPerks: selectedPerks || [],
          vendorEmail: ticket.vendorEmail || "unknown",
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const bookingResult = await bookingsCollection.insertOne(bookingData);
        await ticketsCollection.updateOne(
          { _id: new ObjectId(ticketId) },
          {
            $inc: { quantity: -seats.length },
            $push: { bookedSeats: { $each: seats } },
          },
        );

        res.send({
          success: true,
          bookingId: bookingResult.insertedId,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    //get api from userCollection for role
    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ success: true, role: user.role });
    });

    //get particular userInformation to show in userDashboard
    app.get("/userProfile/:email", async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send(result);
    });

    //api for getting user booked ticket list
    app.get("/userbookticket/:email", async (req, res) => {
      try {
        const email = req.params.email.trim().toLowerCase();
        const bookings = await bookingsCollection
          .find({ email })
          .sort({
            departureTime: 1,
          })
          .toArray();

        const response = bookings.map((b) => ({
          _id: b._id,
          ticketId: b.ticketId,
          ticketTitle: b.ticketTitle,
          ticketImage: b.ticketImage,
          from: b.from,
          to: b.to,
          departureDateTime: b.departureTime,
          seats: b.seats,
          totalPrice: b.totalPrice,
          selectedPerks: b.selectedPerks,
          vendorEmail: b.vendorEmail,
          status: b.status,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        }));

        res.send(response);
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // api for storing vendor in collection
    app.post("/vendor-request", async (req, res) => {
      const data = req.body;
      const isExist = await vendorCollection.findOne({
        email: data.email,
      });
      if (isExist) {
        return res.send({ success: false, message: "Already Applied" });
      }

      const result = await vendorCollection.insertOne({
        ...data,
        status: "pending",
        createdAt: new Date(),
      });

      res.send({
        success: true,
        message: "Application submitted",
      });
    });

    // create a api for getting tickets for admin dashboard
    app.get("/admin/get-tickets", async (req, res) => {
      const result = await ticketsCollection.find().toArray();
      result.sort((a, b) => {
        const order = { pending: 1, approved: 2, rejected: 3 };
        return (order[a.status] || 4) - (order[b.status] || 4);
      });
      res.send(result);
    });

    // api for updating ticketcollection when admin change the status pending to approve
    app.patch("/admin/ticket/:id/approved", async (req, res) => {
      const id = req.params.id;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } },
      );

      if (result.matchedCount === 0) {
        return res.send({
          success: false,
          message: "Ticket not found",
        });
      }

      res.send({
        success: true,
        result,
      });
    });

    // api for updating ticketcollection when admin change the status pending to reject
    app.patch("/admin/ticket/:id/rejected", async (req, res) => {
      const id = req.params.id;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } },
      );

      if (result.matchedCount === 0) {
        return res.send({
          success: false,
          message: "Ticket not found",
        });
      }

      res.send({
        success: true,
        result,
      });
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
