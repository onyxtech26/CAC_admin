import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import { Icon } from "./components/Icon";
import Home from "./pages/Home";
import About from "./pages/About";
import Services from "./pages/Services";
import ServiceDetail from "./pages/ServiceDetail";
import Process from "./pages/Process";
import WhyCAC from "./pages/WhyCAC";
import Contact from "./pages/Contact";
import SplashScreen from "./components/SplashScreen";
import { CONTACT, waLink } from "./data";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }); }, [pathname]);
  return null;
}

function FloatingWhatsApp() {
  return (
    <a
      href={waLink()}
      target="_blank"
      rel="noreferrer"
      aria-label="WhatsApp CAC"
      className="group fixed bottom-5 right-5 z-40 flex items-center gap-3"
    >
      <span className="pointer-events-none hidden rounded-full border border-gold-2/30 bg-navy-2/90 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2 opacity-0 shadow-lg backdrop-blur transition group-hover:opacity-100 sm:block">
        {CONTACT.phoneDisplay}
      </span>
      <span className="relative grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-gold-2 via-gold to-gold-3 text-navy shadow-[0_14px_30px_-10px_rgba(201,138,4,0.8)] transition group-hover:scale-105">
        <span className="absolute inset-0 rounded-full ring-2 ring-gold-2/40" style={{ animation: "pulse-ring 2.4s ease-out infinite" }} />
        <Icon name="whatsapp" size={26} />
      </span>
    </a>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SplashScreen />
      <ScrollToTop />
      <div className="relative flex min-h-screen flex-col bg-navy text-ivory">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <Navbar />
        <main id="main-content" tabIndex={-1} className="flex-1">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/services" element={<Services />} />
            <Route path="/services/:serviceId" element={<ServiceDetail />} />
            <Route path="/process" element={<Process />} />
            <Route path="/why-cac" element={<WhyCAC />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </main>
        <Footer />
        <FloatingWhatsApp />
      </div>
    </BrowserRouter>
  );
}
