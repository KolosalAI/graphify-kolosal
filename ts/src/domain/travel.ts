import type { DomainDictionary } from "./types.js";

// Base travel / booking dictionary (Plan 11, Pillar C).
export const TRAVEL: DomainDictionary = {
  domain: "travel",
  label: "Travel",
  features: [
    // ── Search & Booking ─────────────────────────────────────────────────────
    { canonical: "Search", category: "Search & Booking", keywords: ["search", "availability", "query", "filter", "fare", "fares"] },
    { canonical: "Booking", category: "Search & Booking", keywords: ["booking", "bookings", "reservation", "reservations", "reserve", "book"] },
    { canonical: "Itinerary", category: "Search & Booking", keywords: ["itinerary", "trip", "trips", "journey", "plan"] },
    { canonical: "Cancellation", category: "Search & Booking", keywords: ["cancel", "cancellation", "refund", "rebook"] },

    // ── Inventory ────────────────────────────────────────────────────────────
    { canonical: "Flight", category: "Inventory", keywords: ["flight", "flights", "air", "airline", "airport"] },
    { canonical: "Hotel", category: "Inventory", keywords: ["hotel", "hotels", "room", "rooms", "accommodation", "lodging", "property"] },
    { canonical: "Car Rental", category: "Inventory", keywords: ["car", "cars", "rental", "vehicle"] },
    { canonical: "Destination", category: "Inventory", keywords: ["destination", "destinations", "location", "city", "place"] },

    // ── Trip Management ──────────────────────────────────────────────────────
    { canonical: "Passenger", category: "Trip Management", keywords: ["passenger", "passengers", "traveler", "traveller", "guest", "pax"] },
    { canonical: "Check-in", category: "Trip Management", keywords: ["checkin", "boarding", "boardingpass"] },
    { canonical: "Baggage", category: "Trip Management", keywords: ["baggage", "luggage", "bag"] },

    // ── Payments & Customer ──────────────────────────────────────────────────
    { canonical: "Payment", category: "Payments", keywords: ["payment", "payments", "pay", "charge", "billing"] },
    { canonical: "Loyalty", category: "Customer", keywords: ["loyalty", "points", "miles", "rewards", "membership"] },
    { canonical: "Reviews", category: "Customer", keywords: ["review", "reviews", "rating", "feedback"] },
    { canonical: "Account", category: "Customer", keywords: ["account", "profile", "user", "customer"] },
    { canonical: "Authentication", category: "Customer", keywords: ["auth", "login", "session", "token", "otp"] },
  ],
};
