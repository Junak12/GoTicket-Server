import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { MongoClient, ServerApiVersion } from 'mongodb';

dotenv.config();
const app = express();

const port = process.env.Port;

//pauljunak_db_user
//d40h7Rvcjnqh6MkJ

app.use(cors())
app.use(express.json());

app.get('/', (req, res) => {
    res.send('GoTicket is running');
})

const uri = process.env.MONGODB_URI;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    await client.connect();
    const db = client.db("goTicket");
    const userCollection = db.collection('user');
    const ticketsCollection = db.collection('tickets');



    // post user
    app.post('/user', async(req, res) => {
        const user = req.body;
        const query = {email:user.email};
        const isExist = await userCollection.findOne(query);
        if (isExist) {
          return res.send({ message: "User already exists", inserted: false })
        }
        const result = await userCollection.insertOne(user);
        res.send(result);
    })
    
    //post ticket
    app.post('/tickets', async(req, res) => {
      const tickets = req.body;
      const result = await ticketsCollection.insertOne(tickets);
      res.send(result);
    })

    //get Ticket
    app.get('/getTicket', async(req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 6;
      const skip = (page - 1) * limit;
      const tickets = await ticketsCollection.find({
        status:"approved"
      }).skip(skip).limit(limit).toArray();
      //const tickets = await ticketsCollection.find({}).toArray();
      const totalTickets = await ticketsCollection.countDocuments({status:"approved"});
      res.send({
        tickets,
        totalPages:Math.ceil(totalTickets / limit),
        currentPage:page,
      });
    });

    //get ticket by search
    app.get('/getTicket/search', async(req, res) => {
      const {from, to, transport} = req.query;
      const query = {
        status:"approved",
      }
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


    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
})