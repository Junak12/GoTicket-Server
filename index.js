import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import Stripe from "stripe";
import admin from "firebase-admin";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET);
const app = express();

const port = process.env.Port;

app.use(cors());
app.use(express.json());

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyRole = (requiredRole, userCollection) => {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ message: "Unauthorized access" });

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    try {
      const decoded = await admin.auth().verifyIdToken(token);
      req.decoded_email = decoded.email;

      const user = await userCollection.findOne({ email: decoded.email });
      if (!user) return res.status(403).json({ message: "User not found" });

      if (requiredRole && user.role !== requiredRole) {
        return res
          .status(403)
          .json({ message: "Access denied: insufficient permissions" });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error("Firebase token error:", error);
      return res.status(403).json({ message: "Forbidden access" });
    }
  };
};

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
    app.post(
      "/tickets",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        try {
          const ticket = {
            ...req.body,
            createdAt: new Date(),
          };

          const result = await ticketsCollection.insertOne(ticket);
          res.status(201).send(result);
        } catch (error) {
          console.error("Error inserting ticket:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      },
    );

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
    // Create Checkout Session
    app.post(
      "/create-checkout-session",
      verifyRole("user", userCollection),
      async (req, res) => {
        try {
          const { totalPrice, email, vendorName, ticketId, seats, bookingId } =
            req.body;

          if (!bookingId) {
            return res.status(400).send({
              success: false,
              message: "Booking ID is required",
            });
          }

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
              bookingId: bookingId, // ✅ Store existing booking
              seats: seats.join(","),
              totalTickets: seats.length.toString(),
              totalPrice: totalPrice.toString(),
              email: email,
            },
            success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
          });

          res.send({ url: session.url });
        } catch (err) {
          console.error("Stripe session error:", err);
          res.status(500).send({
            success: false,
            message: "Could not create checkout session",
          });
        }
      },
    );

    // Verify Payment & Update Booking
    app.post(
      "/verify-payment",
      verifyRole("user", userCollection),
      async (req, res) => {
        try {
          const { sessionId } = req.body;
          if (!sessionId)
            return res
              .status(400)
              .send({ success: false, message: "Session ID required" });

          const session = await stripe.checkout.sessions.retrieve(sessionId);

          if (session.payment_status !== "paid") {
            return res
              .status(400)
              .send({ success: false, message: "Payment not completed" });
          }

          // Check if payment already exists
          const isExist = await paymentsCollection.findOne({
            transactionId: session.payment_intent,
          });

          if (isExist) {
            // Already paid
            const booking = await bookingsCollection.findOne({
              _id: new ObjectId(isExist.bookingId),
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
          const bookingId = session.metadata?.bookingId;
          const seats = session.metadata?.seats?.split(",") || [];
          const totalPrice = parseFloat(session.metadata?.totalPrice) || 0;

          if (!ticketId || !bookingId || seats.length === 0) {
            return res
              .status(400)
              .send({ success: false, message: "Invalid metadata" });
          }

          // Find the ticket
          const ticket = await ticketsCollection.findOne({
            _id: new ObjectId(ticketId),
          });
          if (!ticket)
            return res
              .status(404)
              .send({ success: false, message: "Ticket not found" });

          // Update existing booking
          await bookingsCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: {
                status: "paid",
                paidAt: new Date(),
              },
            },
          );

          // Create payment record
          await paymentsCollection.insertOne({
            email: session.customer_email,
            ticketId: new ObjectId(ticketId),
            bookingId: new ObjectId(bookingId),
            seats,
            totalTickets: seats.length,
            amount: session.amount_total / 100,
            paymentMethod: "stripe",
            transactionId: session.payment_intent,
            status: "success",
            vendorEmail: ticket.vendorEmail || "unknown",
            createdAt: new Date(),
          });

          // Update ticket collection
          await ticketsCollection.updateOne(
            { _id: new ObjectId(ticketId) },
            {
              $inc: { quantity: -seats.length, bookingCount: seats.length },
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
          console.error("Verify payment error:", err);
          res.status(500).send({ success: false, message: "Server error" });
        }
      },
    );

    app.post(
      "/book-ticket",
      verifyRole("user", userCollection),
      async (req, res) => {
        try {
          const { ticketId, email, seats, totalPrice, selectedPerks } =
            req.body;

          const user = await userCollection.findOne({ email });
          if (!user) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          if (user.role === "admin") {
            return res.status(403).send({
              success: false,
              message: "Admin users cannot book tickets",
            });
          }
          if (user.role === "vendor") {
            return res.status(403).send({
              success: false,
              message: "Vendor users cannot book tickets",
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
      },
    );

    //get api from userCollection for role
    app.get("/user/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });

        res.send({
          success: true,
          role: user?.role || "user",
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({
          success: false,
          message: "Server error",
          role: "user", // fallback
        });
      }
    });

    //get particular userInformation to show in userDashboard
    app.get("/userProfile/:email", async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send(result);
    });

    // api for update profile
    app.patch(
      "/update-user/:email",
      verifyRole("user", userCollection),
      async (req, res) => {
        const email = req.params.email;
        const { name, photo } = req.body;

        if (!name && !photo) {
          return res
            .status(400)
            .send({ success: false, message: "Nothing to update" });
        }

        const updateDoc = {
          $set: {},
        };
        if (name) {
          updateDoc.$set.name = name;
        }
        if (photo) {
          updateDoc.$set.photo = photo;
        }
        const result = await userCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }
        res.send({ success: true, message: "Profile updated successfully" });
      },
    );

    //api for getting user booked ticket list
    app.get(
      "/userbookticket/:email",
      verifyRole("user", userCollection),
      async (req, res) => {
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
      },
    );

    // api for storing vendor in collection
    app.post("/vendor-request", async (req, res) => {
      const data = req.body;
      //console.log(data.email);

      const user = await userCollection.findOne({ email: data.email });

      if (user) {
        if (
          user.role === "admin" ||
          user.role === "vendor" ||
          user.role === "fraud"
        ) {
          return res.status(403).send({
            success: false,
            message: `Users with role "${user.role}" cannot apply for vendor.`,
          });
        }
      }

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
    app.get(
      "/admin/get-tickets",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const result = await ticketsCollection.find().toArray();
        result.sort((a, b) => {
          const order = { pending: 1, approved: 2, rejected: 3 };
          return (order[a.status] || 4) - (order[b.status] || 4);
        });
        res.send(result);
      },
    );

    // current logged in ticket details
    app.get("/admin/users", async (req, res) => {
      const email = req.query.email;
      const users = await userCollection
        .find({ email: { $ne: email } })
        .toArray();
      res.send(users);
    });

    // api for updating ticketcollection when admin change the status pending to approve
    app.patch(
      "/admin/ticket/:id/approved",
      verifyRole("admin", userCollection),
      async (req, res) => {
        try {
          const id = req.params.id;

          // Update ticket: status + createdAt
          const result = await ticketsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                status: "approved",
                createdAt: new Date(), // updated to now
              },
            },
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
            message: "Ticket approved and timestamp updated",
          });
        } catch (error) {
          console.error(error);
          res
            .status(500)
            .send({ success: false, message: "Internal Server Error" });
        }
      },
    );

    // api for updating ticketcollection when admin change the status pending to reject
    app.patch(
      "/admin/ticket/:id/rejected",
      verifyRole("admin", userCollection),
      async (req, res) => {
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
      },
    );

    // api for getting all users for manage users  user to admin in admin dashboard
    app.patch(
      "/admin/users/:id/make-admin",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "admin", isFraud: false } },
        );
        res.send({ success: true });
      },
    );

    // api for getting all users for manage users user to vendor in admin dashboard
    app.patch(
      "/admin/users/:id/make-vendor",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "vendor", isFraud: false } },
        );
        res.send({ success: true });
      },
    );

    // api for getting all users for manage users user to fraud in admin dashboard
    app.patch(
      "/admin/users/:id/make-fraud",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "fraud", isFraud: true } },
        );
        res.send({ success: true });
      },
    );

    // api for getting all users for manage vendor application in admin dashboard
    app.get(
      "/admin/vendor-application",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const result = await vendorCollection
          .find({
            status: "pending",
          })
          .toArray();
        res.send(result);
      },
    );

    //api for updating vendor application in admin dashboard to approved
    app.patch(
      "/admin/vendor-application/approve/:id",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;

        const application = await vendorCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!application) {
          return res.status(404).send({
            success: false,
            message: "Application not found!",
          });
        }

        const user = await userCollection.findOne({
          email: application.email,
        });

        if (!user) {
          await vendorCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "approved" } },
          );
          await userCollection.insertOne({
            name: application.fullName,
            email: application.email,
            photo: "",
            role: "vendor",
            createdAt: new Date(),
          });
          return res.send({
            success: true,
            message: "Vendor approved & new user created!",
          });
        }

        await vendorCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "approved" } },
        );
        await userCollection.updateOne(
          { email: user.email },
          { $set: { role: "vendor" } },
        );
        return res.send({
          success: true,
          message: "Vendor approved & user role updated!",
        });
      },
    );

    //api for updating vendor application in admin dashboard to reject
    app.patch(
      "/admin/vendor-application/reject/:id",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const application = await vendorCollection.find({
          _id: new ObjectId(id),
        });

        if (!application) {
          return res.status(404).send({
            success: false,
            message: "Email not Found",
          });
        }

        await vendorCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "Rejected" } },
        );
        res.send({
          success: true,
          message: "Vendor Application Rejected Successfully",
        });
      },
    );

    //api for getting all tickets without pagination in admin dashboard Advertise ticket page
    app.get(
      "/admin/all-tickets",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const result = await ticketsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    //api for advertise the ticket in admin dashboard advertise ticket page
    app.patch(
      "/admin/tickets/advertise/:id",
      verifyRole("admin", userCollection),
      async (req, res) => {
        const id = req.params.id;

        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!ticket) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        const current = ticket.isAdvertised;

        if (!current) {
          const count = await ticketsCollection.countDocuments({
            isAdvertised: true,
          });

          if (count >= 6) {
            return res.status(400).send({
              success: false,
              message: "You cannot advertise more than 6 tickets at a time!",
            });
          }
        }

        await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isAdvertised: !current } },
        );

        res.send({
          success: true,
          message: current
            ? "Ticket removed from Advertisement!"
            : "Ticket Advertised successfully!",
        });
      },
    );

    //api for shwoing advertisement ticket section in home page
    app.get("/home/tickets", async (req, res) => {
      const result = await ticketsCollection
        .find({ isAdvertised: true })
        .toArray();
      res.send(result);
    });

    //api for showing latest tickets in home page
    app.get("/latest-tickets", async (req, res) => {
      try {
        const result = await ticketsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch tickets" });
      }
    });

    //api for getting my added task in vendor dashboard
    app.get(
      "/vendor/get-ticket/:email",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        const email = req.params.email;
        const result = await ticketsCollection
          .find({
            vendorEmail: email,
          })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    // api for deleting tickets my vendor in My added tickets in vendor dashbaord
    app.delete(
      "/vendor/my-tickets/delete-ticket/:id",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const result = await ticketsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        res.send({
          success: true,
          message: "Ticket deleted successfully",
        });
      },
    );

    // api for updating ticket details in my added tickets in vendor dashboard
    app.patch(
      "/vendor/my-tickets/update-ticket/:id",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        try {
          const id = req.params.id;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket ID",
            });
          }

          const updatedData = req.body;
          const allowedFields = [
            "title",
            "from",
            "to",
            "transportType",
            "price",
            "quantity",
            "departureDateTime",
            "image",
            "perks",
          ];

          const filteredData = {};
          allowedFields.forEach((field) => {
            if (updatedData[field] !== undefined) {
              filteredData[field] = updatedData[field];
            }
          });

          filteredData.updatedAt = new Date();
          const result = await ticketsCollection.updateOne(
            { _id: new ObjectId(id), status: { $ne: "rejected" } },
            { $set: filteredData },
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found or already rejected",
            });
          }

          res.send({
            success: true,
            message: "Ticket updated successfully",
          });
        } catch (error) {
          console.error("Update error:", error);
          res.status(500).send({
            success: false,
            message: "Update failed",
            error: error.message,
          });
        }
      },
    );

    //api for getting booked tickets as pending in requested bookings in vendor dashboard
    app.get(
      "/vendor/req-bookings/:email",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        const email = req.params.email;
        const result = await bookingsCollection
          .find({ vendorEmail: email, status: "pending" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    // api for updating status of booking ticket in request booking page in vendor dashboard
    app.patch(
      "/vendor/req-bookings/approved/:id",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Booking not found",
          });
        }

        const result = await bookingsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "approved",
              updatedAt: new Date(),
            },
          },
        );
        res.send({
          success: true,
          message: "Booking request has been approved successfully!",
          result,
        });
      },
    );

    //api for rejecting status of booking ticket in requesting booking page in vendor dashboard
    app.patch(
      "/vendor/req-bookings/reject/:id",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        const id = req.params.id;
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Bookings not found!",
          });
        }

        const result = await bookingsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "rejected",
              updatedAt: new Date(),
            },
          },
        );
        res.send({
          success: true,
          message: "Booking status has been rejected!",
          result,
        });
      },
    );

    //api for showing total revenue in vendor dashboard revenue page
    app.get(
      "/vendor/revenue-overview",
      verifyRole("vendor", userCollection),
      async (req, res) => {
        try {
          const paymentStats = await paymentsCollection
            .aggregate([
              {
                $match: { status: "success" },
              },
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: "$amount" },
                  totalTicketsSold: { $sum: "$totalTickets" },
                },
              },
            ])
            .toArray();
          const totalTicketsAdded = await ticketsCollection.countDocuments();

          res.send({
            totalRevenue: paymentStats[0]?.totalRevenue || 0,
            totalTicketsSold: paymentStats[0]?.totalTicketsSold || 0,
            totalTicketsAdded,
          });
        } catch (error) {
          console.error(error);
          res.status(500).send({ error: "Failed to load stats" });
        }
      },
    );

    //api for showing transaction history in user dashboard
    app.get(
      "/user/transactions/:email",
      verifyRole("user", userCollection),
      async (req, res) => {
        const payments = await paymentsCollection
          .find({ email: req.params.email })
          .toArray();

        const ticketIds = payments.map((p) => p.ticketId);

        const tickets = await ticketsCollection
          .find({ _id: { $in: ticketIds } })
          .toArray();

        const ticketMap = {};
        tickets.forEach((t) => {
          ticketMap[t._id] = t.title;
        });

        const result = payments.map((p) => ({
          ...p,
          ticketTitle: ticketMap[p.ticketId] || "Unknown",
        }));

        res.send(result);
      },
    );

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
