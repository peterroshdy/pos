import { ArrowLeft, Clock3, MapPin, ReceiptText } from "lucide-react";
import { Link } from "react-router-dom";

type ReceiptDesign = {
  id: number;
  name: string;
  description: string;
  className: string;
  closing: string;
};

const designs: ReceiptDesign[] = [
  { id: 1, name: "Classic Counter", description: "Familiar, balanced, and easy to scan.", className: "classic", closing: "Thank you for visiting Talk & TASTE" },
  { id: 2, name: "Modern Ledger", description: "Strong hierarchy with clean financial rows.", className: "modern", closing: "Made fresh. Served with care." },
  { id: 3, name: "Fast & Minimal", description: "The shortest layout for busy service.", className: "minimal", closing: "Thank you — see you soon." },
  { id: 4, name: "Bold Order", description: "Makes the order number impossible to miss.", className: "bold", closing: "TALK. TASTE. REPEAT." },
  { id: 5, name: "Cafe Journal", description: "A warmer, editorial coffee-shop style.", className: "journal", closing: "A good day starts with good coffee." },
  { id: 6, name: "Precision", description: "Dense alignment for accounting clarity.", className: "precision", closing: "Keep this receipt for your records." },
  { id: 7, name: "Framed Ticket", description: "A structured ticket with a clear border.", className: "framed", closing: "Thank you for choosing us." },
  { id: 8, name: "Black Label", description: "High-contrast brand and total treatment.", className: "black-label", closing: "BREWED FOR CITY STARS" },
  { id: 9, name: "Friendly Round", description: "Soft sections and approachable typography.", className: "friendly", closing: "Thanks a latte!" },
  { id: 10, name: "Order Strip", description: "Operational style with barcode-like reference.", className: "order-strip", closing: "Order complete · Have a great day" },
];

const items = [
  { quantity: 2, name: "Cappuccino", detail: "Regular · Extra hot", amount: "180.00" },
  { quantity: 1, name: "Iced Spanish Latte", detail: "Large", amount: "115.00" },
  { quantity: 1, name: "Butter Croissant", detail: "Warmed", amount: "65.00" },
];

function ReceiptPreview({ design }: { design: ReceiptDesign }) {
  return (
    <article className={`receipt-design-card receipt-design-card--${design.className}`}>
      <header className="receipt-design-card__heading">
        <span>Design {String(design.id).padStart(2, "0")}</span>
        <h3>{design.name}</h3>
        <p>{design.description}</p>
      </header>

      <div className="thermal-receipt">
        <div className="thermal-receipt__brand">
          <span className="thermal-receipt__mark">T&amp;T</span>
          <h4>Talk &amp; TASTE</h4>
          <p>City Stars Branch</p>
          <small>Omar Ibn El Khattab St. · Cairo</small>
        </div>

        <div className="thermal-receipt__rule" />

        <div className="thermal-receipt__order">
          <strong>ORDER #CS-10428</strong>
          <span>SALE</span>
        </div>

        <dl className="thermal-receipt__meta">
          <div><dt>Date</dt><dd>03 Oct 2026 · 9:42 PM</dd></div>
          <div><dt>Barista</dt><dd>Barista</dd></div>
          <div><dt>Shift</dt><dd>#0042</dd></div>
        </dl>

        <div className="thermal-receipt__rule thermal-receipt__rule--light" />

        <div className="thermal-receipt__items">
          <div className="thermal-receipt__item thermal-receipt__item--labels">
            <span>ITEM</span><span>AMOUNT</span>
          </div>
          {items.map((item) => (
            <div className="thermal-receipt__item" key={item.name}>
              <div>
                <strong>{item.quantity} × {item.name}</strong>
                <small>{item.detail}</small>
              </div>
              <span>{item.amount}</span>
            </div>
          ))}
        </div>

        <div className="thermal-receipt__rule" />

        <dl className="thermal-receipt__totals">
          <div><dt>Subtotal</dt><dd>EGP 360.00</dd></div>
          <div><dt>VAT</dt><dd>Disabled</dd></div>
          <div className="thermal-receipt__grand-total"><dt>TOTAL</dt><dd>EGP 360.00</dd></div>
        </dl>

        <dl className="thermal-receipt__payment">
          <div><dt>Cash received</dt><dd>EGP 400.00</dd></div>
          <div><dt>Change</dt><dd>EGP 40.00</dd></div>
        </dl>

        <div className="thermal-receipt__reference">
          <div className="thermal-receipt__barcode" aria-hidden="true" />
          <small>CS10428-20261003-2142</small>
        </div>

        <footer>
          <strong>{design.closing}</strong>
          <span>talkandtaste.app</span>
        </footer>
      </div>
    </article>
  );
}

export function ReceiptDesignsPage() {
  return (
    <div className="content-page receipt-designs-page" dir="ltr" data-no-localize>
      <div className="receipt-designs-hero">
        <div>
          <span className="receipt-designs-hero__tag"><ReceiptText size={15} /> Temporary review page</span>
          <h2>Choose a receipt direction</h2>
          <p>Ten English-only concepts sized to represent an 80 mm thermal receipt. Prices and transaction data are examples.</p>
        </div>
        <Link className="soft-button" to="/settings#receipt"><ArrowLeft size={17} /> Back to settings</Link>
      </div>

      <div className="receipt-designs-note">
        <span><MapPin size={16} /> City Stars Branch</span>
        <span><Clock3 size={16} /> Preview data · 03 Oct 2026</span>
        <strong>English receipts only</strong>
      </div>

      <section className="receipt-designs-grid" aria-label="Receipt design previews">
        {designs.map((design) => <ReceiptPreview design={design} key={design.id} />)}
      </section>
    </div>
  );
}
