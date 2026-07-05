import type { DomainDictionary } from "./types.js";

// Base e-commerce dictionary (Plan 11, Pillar C). Keywords are normalized (lowercase,
// alnum) synonyms that map a discovered domain token to a canonical feature + category.
export const ECOMMERCE: DomainDictionary = {
  domain: "ecommerce",
  label: "E-commerce",
  features: [
    // ── Catalog ──────────────────────────────────────────────────────────────
    { canonical: "Product", category: "Catalog", keywords: ["product", "products", "item", "items", "sku", "listing", "merchandise", "goods"] },
    { canonical: "Catalog", category: "Catalog", keywords: ["catalog", "catalogue", "collection", "department", "category", "categories", "browse"] },
    { canonical: "Product Search", category: "Catalog", keywords: ["search", "query", "filter", "facet", "autocomplete", "productsearch"] },
    { canonical: "Recommendations", category: "Catalog", keywords: ["recommendation", "recommendations", "recommend", "suggestion", "related", "personalization"] },
    { canonical: "Reviews", category: "Catalog", keywords: ["review", "reviews", "rating", "ratings", "feedback"] },
    { canonical: "Homepage", category: "Catalog", keywords: ["home", "homepage", "landing", "storefront", "featured"] },

    // ── Cart & Checkout ──────────────────────────────────────────────────────
    { canonical: "Cart", category: "Cart & Checkout", keywords: ["cart", "basket", "bag", "shoppingcart", "cartitem"] },
    { canonical: "Checkout", category: "Cart & Checkout", keywords: ["checkout", "purchase"] },
    { canonical: "Wishlist", category: "Cart & Checkout", keywords: ["wishlist", "favorite", "favorites", "saved", "savedlist"] },
    { canonical: "Coupon", category: "Cart & Checkout", keywords: ["coupon", "promo", "promotion", "discount", "voucher", "deal", "flashsale"] },

    // ── Orders & Fulfillment ─────────────────────────────────────────────────
    { canonical: "Order", category: "Orders", keywords: ["order", "orders", "orderitem", "purchaseorder"] },
    { canonical: "Shipping", category: "Orders", keywords: ["shipping", "delivery", "fulfillment", "shipment", "courier", "tracking"] },
    { canonical: "Returns", category: "Orders", keywords: ["return", "returns", "refund", "rma", "exchange"] },
    { canonical: "Inventory", category: "Orders", keywords: ["inventory", "stock", "warehouse", "supplier"] },

    // ── Payments ─────────────────────────────────────────────────────────────
    { canonical: "Payment", category: "Payments", keywords: ["payment", "payments", "pay", "charge", "billing", "stripe", "paypal", "checkoutsession"] },
    { canonical: "Invoice", category: "Payments", keywords: ["invoice", "receipt", "billing"] },

    // ── Customer ─────────────────────────────────────────────────────────────
    { canonical: "Account", category: "Customer", keywords: ["account", "profile", "customer", "user"] },
    { canonical: "Address", category: "Customer", keywords: ["address", "addresses", "shippingaddress", "billingaddress"] },
    { canonical: "Authentication", category: "Customer", keywords: ["auth", "login", "logout", "signup", "register", "session", "token"] },
  ],
};
