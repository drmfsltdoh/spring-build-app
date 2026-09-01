require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// SECURITY: the Mongo URI now comes from .env — never hardcode credentials in code.
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Missing MONGODB_URI in .env — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const client = new MongoClient(uri);

// Keep these in sync with mobile/src/utils/fare.js — the mobile app and this
// backend are separate runtimes, so the constants are duplicated. If you
// change the fare formula on one side, change it here too.
const FUEL_COST_PER_KM = 1500 / 10;    // ₦1500/liter ÷ 10 km/liter
const PLATFORM_FEE_RATE = 0.10;        // Spring's cut of every completed fare
const VALID_CATEGORIES = ["economy", "comfort", "xl", "green"];

let ridesCollection;
let usersCollection;
let driversCollection;
let messagesCollection;
let reviewsCollection;
let walletsCollection;
let walletTransactionsCollection;

async function connectToDatabase() {
  await client.connect();
  const db = client.db("ridego");
  ridesCollection = db.collection("rides");
  usersCollection = db.collection("users");
  driversCollection = db.collection("drivers");
  messagesCollection = db.collection("messages");
  reviewsCollection = db.collection("reviews");
  walletsCollection = db.collection("wallets");
  walletTransactionsCollection = db.collection("walletTransactions");

  // Keep signups unique and lookups fast. safe to run every boot — no-ops if they already exist.
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await driversCollection.createIndex({ email: 1 }, { unique: true });
  await ridesCollection.createIndex({ driverId: 1, createdAt: -1 });
  await ridesCollection.createIndex({ riderEmail: 1, createdAt: -1 });
  await messagesCollection.createIndex({ rideId: 1, createdAt: 1 });
  await walletsCollection.createIndex({ email: 1 }, { unique: true });
  await walletTransactionsCollection.createIndex({ email: 1, createdAt: -1 });

  console.log("Connected to MongoDB!");
}

connectToDatabase().catch((err) => {
  console.error("Failed to connect to MongoDB:", err.message);
  process.exit(1);
});

// ---------- helpers ----------

// Turns a route handler that returns a rejected promise (bad input, DB error,
// etc.) into a clean JSON error response instead of an unhandled rejection /
// a raw stack-trace dump to the client.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Guards every `new ObjectId(someParam)` call — previously a malformed id in
// the URL (e.g. a typo, or someone poking the API) threw synchronously
// inside an async function and the request would just hang with no
// response. Now it's a clean 400.
function toObjectId(id, label = "id") {
  if (!ObjectId.isValid(id)) {
    const err = new Error(`Invalid ${label}`);
    err.status = 400;
    throw err;
  }
  return new ObjectId(id);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

app.get("/", (req, res) => {
  res.send("Spring backend is running!");
});

// ---------- AUTH ----------

app.post("/api/signup", asyncRoute(async (req, res) => {
  const { name, email, password, role, phone, car, plate, vehicleType } = req.body;
  if (!name || !email || !password || !role) {
    throw badRequest("name, email, password and role are required");
  }
  if (!["rider", "driver"].includes(role)) {
    throw badRequest('role must be "rider" or "driver"');
  }
  if (password.length < 6) {
    throw badRequest("password must be at least 6 characters");
  }
  if (role === "driver" && vehicleType && !VALID_CATEGORIES.includes(vehicleType)) {
    throw badRequest(`vehicleType must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await usersCollection.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw badRequest("Email already registered");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { name: name.trim(), email: normalizedEmail, password: hashedPassword, role, phone: phone?.trim() || null };
  const result = await usersCollection.insertOne(newUser);

  // Every rider (and driver) gets a Spring Wallet the moment they sign up,
  // starting at ₦0 — this is what backs the Payments → Spring Wallet screen.
  await walletsCollection.insertOne({ email: normalizedEmail, balance: 0, createdAt: new Date() });

  // If signing up as a driver, also create their driver profile
  let driverId;
  if (role === "driver") {
    const driverResult = await driversCollection.insertOne({
      userId: result.insertedId,
      name: name.trim(),
      email: normalizedEmail,
      car: car?.trim() || "Unknown vehicle",
      plate: plate?.trim() || "N/A",
      vehicleType: vehicleType || "economy", // economy | comfort | xl | green — which rider category this driver serves
      rating: 5.0,
      online: false,
      location: null, // { lat, lng }
    });
    driverId = driverResult.insertedId;
  }

  res.json({ message: "Signup successful!", name: newUser.name, email: normalizedEmail, phone: newUser.phone, role, driverId, vehicleType: role === "driver" ? (vehicleType || "economy") : undefined });
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw badRequest("email and password are required");

  const normalizedEmail = email.trim().toLowerCase();
  const user = await usersCollection.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  let driverId;
  let vehicleType;
  if (user.role === "driver") {
    const driverProfile = await driversCollection.findOne({ email: user.email });
    driverId = driverProfile?._id;
    vehicleType = driverProfile?.vehicleType;
  }

  // Backfill a wallet for accounts created before wallets existed.
  await walletsCollection.updateOne(
    { email: normalizedEmail },
    { $setOnInsert: { email: normalizedEmail, balance: 0, createdAt: new Date() } },
    { upsert: true }
  );

  res.json({ message: "Login successful!", name: user.name, email: user.email, phone: user.phone || null, role: user.role, driverId, vehicleType });
}));

// Update name/phone from the Profile screen.
app.patch("/api/profile", asyncRoute(async (req, res) => {
  const { email, name, phone } = req.body;
  if (!email) throw badRequest("email is required");
  const update = {};
  if (typeof name === "string" && name.trim()) update.name = name.trim();
  if (typeof phone === "string") update.phone = phone.trim() || null;
  if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

  const normalizedEmail = email.trim().toLowerCase();
  const result = await usersCollection.findOneAndUpdate(
    { email: normalizedEmail },
    { $set: update },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "User not found" });
  // Keep the driver profile's display name in sync too, if this user is a driver.
  if (update.name) {
    await driversCollection.updateOne({ email: normalizedEmail }, { $set: { name: update.name } });
  }
  res.json({ message: "Profile updated", name: result.name, phone: result.phone || null });
}));

// ---------- DRIVERS ----------

// Driver goes online/offline and updates live location
app.post("/api/driver/status", asyncRoute(async (req, res) => {
  const { email, online, location } = req.body;
  if (!email || typeof online !== "boolean") {
    throw badRequest("email and a boolean online are required");
  }
  if (location && (typeof location.lat !== "number" || typeof location.lng !== "number")) {
    throw badRequest("location must be { lat: number, lng: number }");
  }

  const result = await driversCollection.updateOne(
    { email: email.trim().toLowerCase() },
    { $set: { online, ...(location ? { location } : {}) } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Driver not found" });
  }
  res.json({ message: "Driver status updated" });
}));

// Rider-facing: list of currently online/available drivers
app.get("/api/drivers/available", asyncRoute(async (req, res) => {
  const drivers = await driversCollection.find({ online: true }).toArray();
  res.json(drivers);
}));

// Rider-facing: fetch one driver's current info + live location (used for real-time tracking)
app.get("/api/driver/:id", asyncRoute(async (req, res) => {
  const driver = await driversCollection.findOne({ _id: toObjectId(req.params.id, "driver id") });
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  res.json(driver);
}));

// ---------- RIDES ----------

// Rider requests a SPECIFIC driver (browse-and-pick flow)
app.post("/api/rides/request", asyncRoute(async (req, res) => {
  const { riderEmail, riderName, driverId, pickup, destination, category, estimatedFare } = req.body;
  if (!riderEmail || !driverId || !pickup?.trim() || !destination?.trim()) {
    throw badRequest("riderEmail, driverId, pickup and destination are required");
  }
  if (category && !VALID_CATEGORIES.includes(category)) {
    throw badRequest(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  const driver = await driversCollection.findOne({ _id: toObjectId(driverId, "driver id") });
  if (!driver || !driver.online) {
    throw badRequest("That driver is no longer available");
  }

  const newRide = {
    riderEmail: riderEmail.trim().toLowerCase(),
    riderName,
    driverId: driver._id,
    driverName: driver.name,
    pickup: pickup.trim(),
    destination: destination.trim(),
    category: category || "economy",
    estimatedFare: typeof estimatedFare === "number" ? Math.round(estimatedFare) : null,
    status: "requested", // requested -> accepted -> in_progress -> completed | declined
    distanceKm: null, // filled in once the trip completes
    fare: null,        // filled in once the trip completes
    createdAt: new Date(),
  };
  const result = await ridesCollection.insertOne(newRide);
  res.json({ message: "Ride requested!", id: result.insertedId, ride: { ...newRide, _id: result.insertedId } });
}));

// Driver portal: see incoming requests addressed to them
app.get("/api/rides/driver/:driverId", asyncRoute(async (req, res) => {
  const rides = await ridesCollection
    .find({ driverId: toObjectId(req.params.driverId, "driver id") })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(rides);
}));

// Rider: see their own ride history / current ride status
app.get("/api/rides/rider/:riderEmail", asyncRoute(async (req, res) => {
  const rides = await ridesCollection
    .find({ riderEmail: req.params.riderEmail.trim().toLowerCase() })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(rides);
}));

// Driver accepts a ride request
app.post("/api/rides/:id/accept", asyncRoute(async (req, res) => {
  const result = await ridesCollection.updateOne(
    { _id: toObjectId(req.params.id), status: "requested" },
    { $set: { status: "accepted" } }
  );
  if (result.matchedCount === 0) {
    return res.status(409).json({ error: "Ride is no longer pending (already accepted/declined)" });
  }
  res.json({ message: "Ride accepted" });
}));

// Driver declines a ride request
app.post("/api/rides/:id/decline", asyncRoute(async (req, res) => {
  const result = await ridesCollection.updateOne(
    { _id: toObjectId(req.params.id), status: "requested" },
    { $set: { status: "declined" } }
  );
  if (result.matchedCount === 0) {
    return res.status(409).json({ error: "Ride is no longer pending" });
  }
  res.json({ message: "Ride declined" });
}));

// Either party marks the trip in progress / completed.
// When completing, the client (driver app, which tracks the live GPS
// distance) can pass distanceKm + fare so the final price is saved on the
// ride — otherwise it only ever existed in that screen's in-memory state
// and every other screen (rider history, receipts) had no way to show it.
app.post("/api/rides/:id/status", asyncRoute(async (req, res) => {
  const { status, distanceKm, fare } = req.body; // "in_progress" | "completed"
  if (!["in_progress", "completed"].includes(status)) {
    throw badRequest('status must be "in_progress" or "completed"');
  }

  const update = { status };
  if (status === "completed") {
    update.completedAt = new Date();
    if (typeof distanceKm === "number") update.distanceKm = Math.max(0, distanceKm);
    if (typeof fare === "number") update.fare = Math.max(0, Math.round(fare));
  }

  const result = await ridesCollection.updateOne({ _id: toObjectId(req.params.id) }, { $set: update });
  if (result.matchedCount === 0) return res.status(404).json({ error: "Ride not found" });
  res.json({ message: `Ride marked as ${status}` });
}));

// ---------- MESSAGES (rider <-> driver chat, scoped to one ride) ----------

// Send a message on a ride's chat thread
app.post("/api/rides/:id/messages", asyncRoute(async (req, res) => {
  const { senderRole, senderName, text } = req.body; // senderRole: "rider" | "driver"
  if (!senderRole || !text?.trim()) {
    throw badRequest("senderRole and text are required");
  }
  const message = {
    rideId: toObjectId(req.params.id),
    senderRole,
    senderName,
    text: text.trim().slice(0, 2000),
    createdAt: new Date(),
  };
  const result = await messagesCollection.insertOne(message);
  res.json({ message: "Sent", data: { ...message, _id: result.insertedId } });
}));

// Fetch all messages for a ride's chat thread, oldest first
app.get("/api/rides/:id/messages", asyncRoute(async (req, res) => {
  const messages = await messagesCollection
    .find({ rideId: toObjectId(req.params.id) })
    .sort({ createdAt: 1 })
    .toArray();
  res.json(messages);
}));

// ---------- REVIEWS ----------

// Rider (or driver) leaves a review after a completed ride
app.post("/api/rides/:id/review", asyncRoute(async (req, res) => {
  const { fromRole, rating, comment } = req.body; // fromRole: "rider" | "driver"
  if (!fromRole || !rating) {
    throw badRequest("fromRole and rating are required");
  }
  if (typeof rating !== "number" || rating < 1 || rating > 5) {
    throw badRequest("rating must be a number between 1 and 5");
  }

  const ride = await ridesCollection.findOne({ _id: toObjectId(req.params.id) });
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const review = {
    rideId: ride._id,
    driverId: ride.driverId,
    fromRole,
    rating,
    comment: comment?.trim().slice(0, 1000) || "",
    createdAt: new Date(),
  };
  await reviewsCollection.insertOne(review);

  // If a rider reviewed the driver, recalculate that driver's average rating
  if (fromRole === "rider" && ride.driverId) {
    const driverReviews = await reviewsCollection.find({ driverId: ride.driverId, fromRole: "rider" }).toArray();
    const avg = driverReviews.reduce((sum, r) => sum + r.rating, 0) / driverReviews.length;
    await driversCollection.updateOne({ _id: ride.driverId }, { $set: { rating: avg } });
  }

  res.json({ message: "Review submitted" });
}));

// Get all reviews for a specific driver
app.get("/api/driver/:id/reviews", asyncRoute(async (req, res) => {
  const reviews = await reviewsCollection
    .find({ driverId: toObjectId(req.params.id), fromRole: "rider" })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(reviews);
}));

// Driver-facing earnings dashboard. Everything here is computed from real
// ride records — nothing is a placeholder number. "Today" = since local
// midnight on the server; if your driver base spans multiple time zones,
// swap this for a per-driver timezone later.
app.get("/api/driver/:id/summary", asyncRoute(async (req, res) => {
  const driverId = toObjectId(req.params.id, "driver id");
  const driver = await driversCollection.findOne({ _id: driverId });
  if (!driver) return res.status(404).json({ error: "Driver not found" });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const allRides = await ridesCollection.find({ driverId }).toArray();
  const completedToday = allRides.filter(
    (r) => r.status === "completed" && r.completedAt && new Date(r.completedAt) >= startOfToday
  );

  const grossFaresToday = completedToday.reduce((sum, r) => sum + (r.fare || 0), 0);
  const distanceTodayKm = completedToday.reduce((sum, r) => sum + (r.distanceKm || 0), 0);
  const fuelCostToday = Math.round(distanceTodayKm * FUEL_COST_PER_KM);
  const platformFeeToday = Math.round(grossFaresToday * PLATFORM_FEE_RATE);
  const netTakeHomeToday = Math.max(0, grossFaresToday - platformFeeToday - fuelCostToday);

  // Acceptance rate: of every ride ever routed to this driver, how many did
  // they accept (accepted/in_progress/completed) vs actively decline?
  // Requests still sitting as "requested" (not yet answered) don't count
  // either way.
  const answered = allRides.filter((r) => r.status !== "requested");
  const accepted = answered.filter((r) => r.status !== "declined");
  const acceptanceRate = answered.length ? Math.round((accepted.length / answered.length) * 100) : 100;

  res.json({
    tripsToday: completedToday.length,
    grossFaresToday,
    platformFeeToday,
    fuelCostToday,
    netTakeHomeToday,
    acceptanceRate,
    rating: driver.rating ?? 5.0,
    totalTripsAllTime: allRides.filter((r) => r.status === "completed").length,
  });
}));

// ---------- PLACES (server-side proxy for Google Places) ----------
// The mobile app used to call Google's Places Web Service directly with the
// same key given to the Android Maps SDK. That key is (correctly)
// restricted to the Android app's package name + SHA-1 fingerprint, which
// Google can verify for native SDK calls but NOT for a plain HTTPS request
// coming from JS — so those requests were silently failing with
// REQUEST_DENIED and the app just showed no results. Proxying through here
// lets us use a separate, server-side key instead.
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PLACES_BIAS_LOCATION = "5.49,7.20"; // South-East Nigeria, Spring's operating area
const PLACES_BIAS_RADIUS = 120000; // meters

app.get("/api/places/autocomplete", asyncRoute(async (req, res) => {
  if (!PLACES_KEY) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY is not configured on the server" });
  const { query } = req.query;
  if (!query || query.trim().length < 2) return res.json({ predictions: [] });

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&location=${PLACES_BIAS_LOCATION}&radius=${PLACES_BIAS_RADIUS}&components=country:ng&key=${PLACES_KEY}`;
  const googleRes = await fetch(url);
  const data = await googleRes.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    console.error("Places autocomplete error:", data.status, data.error_message);
    return res.status(502).json({ error: data.error_message || data.status });
  }
  res.json({
    predictions: (data.predictions || []).map((p) => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text || p.description,
      secondaryText: p.structured_formatting?.secondary_text || "",
      description: p.description,
    })),
  });
}));

app.get("/api/places/details", asyncRoute(async (req, res) => {
  if (!PLACES_KEY) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY is not configured on the server" });
  const { placeId } = req.query;
  if (!placeId) throw badRequest("placeId is required");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,formatted_address,geometry&key=${PLACES_KEY}`;
  const googleRes = await fetch(url);
  const data = await googleRes.json();
  if (data.status !== "OK") {
    console.error("Places details error:", data.status, data.error_message);
    return res.status(502).json({ error: data.error_message || data.status });
  }
  const r = data.result;
  res.json({ name: r.name, address: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng });
}));

app.get("/api/places/nearby", asyncRoute(async (req, res) => {
  if (!PLACES_KEY) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY is not configured on the server" });
  const { lat, lng, radius } = req.query;
  if (!lat || !lng) throw badRequest("lat and lng are required");

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius || 4000}&rankby=prominence&key=${PLACES_KEY}`;
  const googleRes = await fetch(url);
  const data = await googleRes.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    console.error("Places nearby error:", data.status, data.error_message);
    return res.status(502).json({ error: data.error_message || data.status });
  }
  res.json({
    results: (data.results || []).slice(0, 10).map((r) => ({
      placeId: r.place_id,
      name: r.name,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      rating: r.rating,
    })),
  });
}));

// ---------- SPRING WALLET ----------
// A simple in-house balance + ledger. There's no real payment processor
// wired in yet, so "Top up" here is a manual/simulated credit (clearly
// labeled as such to the rider) rather than a real card charge — swap the
// topup handler for a real payment gateway webhook when Spring adds one.

app.get("/api/wallet/:email", asyncRoute(async (req, res) => {
  const normalizedEmail = req.params.email.trim().toLowerCase();
  const wallet = await walletsCollection.findOneAndUpdate(
    { email: normalizedEmail },
    { $setOnInsert: { email: normalizedEmail, balance: 0, createdAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  const transactions = await walletTransactionsCollection
    .find({ email: normalizedEmail })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  res.json({ balance: wallet.balance, transactions });
}));

app.post("/api/wallet/:email/topup", asyncRoute(async (req, res) => {
  const normalizedEmail = req.params.email.trim().toLowerCase();
  const { amount } = req.body;
  if (typeof amount !== "number" || amount <= 0) throw badRequest("amount must be a positive number");

  await walletsCollection.updateOne(
    { email: normalizedEmail },
    { $setOnInsert: { email: normalizedEmail, createdAt: new Date() }, $inc: { balance: Math.round(amount) } },
    { upsert: true }
  );
  const tx = {
    email: normalizedEmail,
    type: "topup",
    amount: Math.round(amount),
    note: "Wallet top-up (simulated — no real payment gateway connected yet)",
    createdAt: new Date(),
  };
  await walletTransactionsCollection.insertOne(tx);
  const wallet = await walletsCollection.findOne({ email: normalizedEmail });
  res.json({ message: "Wallet topped up", balance: wallet.balance, transaction: tx });
}));

// ---------- SPRING SEND (package / waybill delivery) ----------
// Reuses the ridesCollection so the whole accept/decline/status/chat
// pipeline built for rides works unchanged for packages — a package is
// just a ride with type: "package" plus a few package-only fields.

app.post("/api/packages/request", asyncRoute(async (req, res) => {
  const { riderEmail, riderName, driverId, pickup, destination, size, price, recipientName, recipientPhone, note } = req.body;
  if (!riderEmail || !driverId || !pickup?.trim() || !destination?.trim() || !size) {
    throw badRequest("riderEmail, driverId, pickup, destination and size are required");
  }
  if (!["small", "medium", "large"].includes(size)) {
    throw badRequest('size must be "small", "medium" or "large"');
  }

  const driver = await driversCollection.findOne({ _id: toObjectId(driverId, "driver id") });
  if (!driver || !driver.online) {
    throw badRequest("That driver is no longer available");
  }

  const newPackage = {
    type: "package",
    riderEmail: riderEmail.trim().toLowerCase(),
    riderName,
    driverId: driver._id,
    driverName: driver.name,
    pickup: pickup.trim(),
    destination: destination.trim(),
    packageSize: size,
    recipientName: recipientName?.trim() || null,
    recipientPhone: recipientPhone?.trim() || null,
    note: note?.trim().slice(0, 500) || null,
    estimatedFare: typeof price === "number" ? Math.round(price) : null,
    status: "requested",
    distanceKm: null,
    fare: null,
    createdAt: new Date(),
  };
  const result = await ridesCollection.insertOne(newPackage);
  res.json({ message: "Package requested!", id: result.insertedId, ride: { ...newPackage, _id: result.insertedId } });
}));

app.get("/api/packages/rider/:riderEmail", asyncRoute(async (req, res) => {
  const packages = await ridesCollection
    .find({ riderEmail: req.params.riderEmail.trim().toLowerCase(), type: "package" })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(packages);
}));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Centralized error handler — every asyncRoute()-wrapped handler above ends
// up here on failure, so callers always get clean JSON instead of a raw
// stack trace or a hung connection.
app.use((err, req, res, next) => {
  if (err.code === 11000) {
    return res.status(400).json({ error: "That email is already registered" });
  }
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Something went wrong" : err.message });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
