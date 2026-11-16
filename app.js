const { useState, useEffect, useRef, useMemo } = React;
const { createClient } = window.supabase;

const DEFAULT_SUPABASE_URL = 'https://qsyubbefhttdfiglbtbt.supabase.co';

// Capture setup_key from URL for instant staff onboarding
const urlParams = new URLSearchParams(window.location.search);
const urlSetupKey = urlParams.get('setup_key');
if (urlSetupKey && urlSetupKey.length > 15) {
  localStorage.setItem('sg_supabase_key', urlSetupKey.trim());
  window.history.replaceState({}, document.title, window.location.pathname);
}

// Simple Lucide Icon wrapper
function Icon({ name, size = 16, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && window.lucide && window.lucide.icons[name]) {
      const svg = window.lucide.createElement(window.lucide.icons[name]);
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
      if (className) svg.setAttribute('class', className);
      ref.current.innerHTML = '';
      ref.current.appendChild(svg);
    }
  }, [name, size, className]);
  return <span ref={ref} className="inline-flex items-center justify-center shrink-0" />;
}

function getDeviceFingerprint() {
  let fp = localStorage.getItem('sg_device_fp');
  if (!fp) {
    fp = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    localStorage.setItem('sg_device_fp', fp);
  }
  return fp;
}

function formatINR(num) {
  const val = Math.round(Number(num) || 0);
  return '₹' + val.toLocaleString('en-IN');
}

function formatDateDDMMYYYY(dateInput) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateTimeDDMMYYYY(dateInput) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${formatDateDDMMYYYY(d)} ${time}`;
}

function getDueUrgency(promisedDateStr, status) {
  if (!promisedDateStr || status === 'Delivered') return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(promisedDateStr + 'T00:00:00');
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return { label: `OVERDUE (${Math.abs(diffDays)}d)`, level: 'overdue' };
  if (diffDays === 0) return { label: 'DUE TODAY', level: 'today' };
  if (diffDays === 1) return { label: 'DUE TOMORROW', level: 'tomorrow' };
  return null;
}

function getHoursInStage(order) {
  const refTime = order.stage_changed_at || order.created_at;
  if (!refTime) return 0;
  return Math.max(0, (Date.now() - new Date(refTime).getTime()) / 3600000);
}

// Math Parsers
function parseLengthExpr(rawStr) {
  const str = String(rawStr ?? '').trim();
  if (!str) return { totalInches: 0, display: '0"' };
  const plusParts = str.split('+').map(s => s.trim()).filter(Boolean);
  let total = 0;
  for (const part of plusParts) {
    if (/[x×*]/i.test(part)) {
      const factors = part.split(/[x×*]/i).map(f => parseFloat(f.trim()));
      if (factors.length >= 2 && factors.every(f => !isNaN(f) && f >= 0)) {
        total += factors.reduce((acc, v) => acc * v, 1);
      }
    } else {
      const val = parseFloat(part);
      if (!isNaN(val) && val >= 0) total += val;
    }
  }
  return { totalInches: Math.round(total * 1000) / 1000, display: `${str}"` };
}

function parseSegmentsList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join('+') : String(input);
  return raw.split(/[+,\s]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
}

function toInt(val) {
  const n = parseInt(String(val ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isInteger(n) ? n : 0;
}

// Unified Estimate Calculator (Handles New Lines + Legacy fields)
function calcEstimate(form = {}) {
  let orderTotal = 0;
  let visitChargeInt = Math.max(0, toInt(form.visit_charge ?? form.visitCharge));
  let advanceInt = Math.max(0, toInt(form.advance_amount ?? form.advanceAmount));

  // Legacy Calculations (For displaying old orders correctly)
  const seatingList = parseSegmentsList(form.seating_segments);
  const seatingInches = seatingList.reduce((acc, n) => acc + n, 0);
  const seatingQuarters = seatingInches > 0 ? Math.ceil(seatingInches / 3) : 0;
  const seatingFeet = seatingQuarters / 4;
  const seatingRateInt = Math.max(0, toInt(form.seating_rate));
  const seatingAmount = Math.round((seatingQuarters * seatingRateInt) / 4);

  const backUnit = form.back_unit === 'Pcs' ? 'Pcs' : 'Inches';
  const backList = parseSegmentsList(form.back_segments);
  const backRaw = backList.reduce((acc, n) => acc + n, 0);
  const backRateInt = Math.max(0, toInt(form.back_rate));
  
  let backQuarters = 0, backBillable = 0, backAmount = 0;
  if (backUnit === 'Inches') {
    backQuarters = backRaw > 0 ? Math.ceil(backRaw / 3) : 0;
    backBillable = backQuarters / 4;
    backAmount = Math.round((backQuarters * backRateInt) / 4);
  } else {
    backBillable = backRaw;
    backAmount = backRaw * backRateInt;
  }

  // Feature A: New Lines Calculation
  let calculatedLines = [];
  if (Array.isArray(form.lines) && form.lines.length > 0) {
    calculatedLines = form.lines.map(line => {
      const rate = Math.max(0, parseFloat(line.rate) || 0);
      let totalInches = 0;
      const segDescriptions = [];
      
      (line.segments || []).forEach(seg => {
        const parsed = parseLengthExpr(seg.length_expr);
        totalInches += parsed.totalInches;
        if (parsed.totalInches > 0 || String(seg.length_expr).trim()) {
          const w = String(seg.width || '').trim();
          const lbl = String(seg.label || '').trim();
          let desc = w ? `${seg.length_expr}"x${w}"` : `${seg.length_expr}"`;
          if (lbl) desc += ` (${lbl})`;
          segDescriptions.push(desc);
        }
      });
      
      totalInches = Math.round(totalInches * 1000) / 1000;
      let amount = 0, feet = 0, pcs = line.segments.length;
      let calcDisplay = '';

      if (line.unit === 'pcs') {
        const pcsCount = totalInches > 0 ? totalInches : 0;
        amount = Math.floor(pcsCount * rate + 1e-9);
        calcDisplay = `${pcsCount} Pcs × ₹${rate} = ₹${amount.toLocaleString('en-IN')}`;
      } else {
        const quarterFeet = totalInches > 0 ? Math.ceil((totalInches - 1e-9) / 3) : 0;
        feet = quarterFeet / 4;
        amount = Math.floor((quarterFeet * rate) / 4 + 1e-9);
        calcDisplay = `${totalInches}" → ${feet.toFixed(2)} ft × ₹${rate} = ₹${amount.toLocaleString('en-IN')}`;
      }
      return { ...line, totalInches, feet, pcs, amount, segJoined: segDescriptions.join(' + ') || '0"', calcDisplay };
    });
    orderTotal = calculatedLines.reduce((sum, l) => sum + l.amount, 0) + visitChargeInt;
  } else {
    orderTotal = seatingAmount + backAmount + visitChargeInt;
  }

  const balance = orderTotal - advanceInt;
  return {
    seatingInches, seatingFeet, seatingAmount, backUnit, backRaw, backBillable, backAmount,
    visitChargeInt, advanceInt, total: orderTotal, balance,
    lines: calculatedLines,
    legacySeatingLine: `Seating: ${seatingList.join(' + ')} = ${seatingInches} in = ${seatingFeet.toFixed(2)} ft × Rs ${seatingRateInt} = Rs ${seatingAmount}`,
    legacyBackLine: backUnit === 'Inches' 
      ? `Back: ${backList.join(' + ')} = ${backRaw} in = ${backBillable.toFixed(2)} ft × Rs ${backRateInt} = Rs ${backAmount}` 
      : `Back: ${backList.join(' + ')} = ${backRaw} pcs × Rs ${backRateInt} = Rs ${backAmount}`,
    summaryLine: `Estimate total: Rs ${orderTotal.toLocaleString('en-IN')} | Advance: Rs ${advanceInt.toLocaleString('en-IN')} | Balance: Rs ${balance.toLocaleString('en-IN')}`
  };
}
const calculateEstimate = calcEstimate;

function getLinePartName(line) {
  if (!line) return 'Part';
  if (line.part === 'Other') return (line.custom_part || 'Other').trim();
  return line.part || 'Seating';
}

const DEFAULT_TEMPLATES = {
  estimate: {
    lang: 'Hinglish',
    text: 'Namaste {customer} ji,\n*Shree Gayatri Furnishing Hub* se aapka Sofa/Furnishing Estimate:\n\n{lines}\n\n*Estimated Total:* Rs {total}\nKoi bhi sawal ho to call karein: {shop_phone}'
  },
  receipt: {
    lang: 'Hinglish',
    text: 'Namaste {customer} ji,\n*Shree Gayatri Furnishing Hub* - Order Receipt ({order_no})\n\n{lines}\n\n*Total:* Rs {total}\n*Advance:* Rs {advance}\n*Balance:* Rs {balance}\n*Promised Date:* {promised_date}\n\n*Important Terms:*\n1. Do not wash in hot water (Garam pani me wash na karein).\n2. Do not machine-dry/spin (Machine-dry ya spin na karein).\n3. For delivery you must go to the 3rd floor (Delivery ke liye 3rd floor par aana hoga).\n4. Advance is non-refundable (Advance non-refundable hai).\n\nContact: {shop_phone}'
  },
  ready: {
    lang: 'Hinglish',
    text: 'Namaste {customer} ji,\nOrder *{order_no}* (*Shree Gayatri*) bankar READY hai!\nBalance Amount: *Rs {balance}*\nNote: Delivery ke liye 3rd floor par aana hoga.\nContact: {shop_phone}'
  },
  reminder: {
    lang: 'Hinglish',
    text: 'Namaste {customer} ji,\n*Shree Gayatri* Order *{order_no}* ka payment reminder:\nTotal: Rs {total} | Advance: Rs {advance}\n*Pending Balance: Rs {balance}*\nKripya balance clear kar ke delivery le jaayein. Contact: {shop_phone}'
  },
  delivered: {
    lang: 'Hinglish',
    text: 'Dhanyawad {customer} ji!\nAapka Order *{order_no}* (*Shree Gayatri*) deliver ho gaya hai.\nCare: Garam pani me wash na karein, machine-dry/spin na karein.\nContact: {shop_phone}'
  }
};

const WhatsAppService = {
  formatPhone(mobile) {
    const digits = String(mobile || '').replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
  },
  getLink(type, order, templates, shopPhone) {
    const phone = this.formatPhone(order.mobile);
    const tplObj = templates?.[type] || DEFAULT_TEMPLATES[type] || DEFAULT_TEMPLATES.receipt;
    
    // Format lines
    let linesFormatted = '';
    if (Array.isArray(order.lines) && order.lines.length > 0) {
      linesFormatted = order.lines.map(l => {
        const c = calcEstimate({lines: [l]}).lines[0];
        const rate = parseFloat(l.rate) || 0;
        if (l.unit === 'pcs') return `• ${getLinePartName(l)} - ${l.design}: ${c.pcs} pcs x Rs ${rate} = Rs ${c.amount}`;
        return `• ${getLinePartName(l)} - ${l.design}: ${c.feet.toFixed(2)} ft x Rs ${rate} = Rs ${c.amount}`;
      }).join('\n');
    } else {
      linesFormatted = `• Design: ${order.design_name}\n• Pieces: ${order.total_pcs}`;
    }

    const msg = (tplObj.text || '')
      .replace(/\{customer\}/g, order.customer_name || 'Customer')
      .replace(/\{order_no\}/g, order.order_no || '')
      .replace(/\{lines\}/g, linesFormatted)
      .replace(/\{total\}/g, formatINR(order.estimate_total))
      .replace(/\{advance\}/g, formatINR(order.advance_amount))
      .replace(/\{balance\}/g, formatINR(order.balance_amount))
      .replace(/\{promised_date\}/g, formatDateDDMMYYYY(order.promised_date))
      .replace(/\{shop_phone\}/g, shopPhone || '');
      
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }
};

function StatusChip({ status }) {
  const map = {
    'Measurement Pending': 'bg-gray-100 text-gray-700 border-gray-300',
    'Estimate Given': 'bg-gray-100 text-gray-800 border-gray-400',
    'Cutting Pending': 'bg-amber-50 text-amber-800 border-amber-300',
    'With Tailor': 'bg-blue-50 text-blue-800 border-blue-300',
    'Silai Done': 'bg-teal-50 text-teal-800 border-teal-300',
    'Ready': 'bg-emerald-50 text-emerald-800 border-emerald-300',
    'Delivered': 'bg-slate-800 text-white border-slate-800'
  };
  const cls = map[status] || 'bg-gray-100 text-gray-700 border-gray-300';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold border whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
}

const INITIAL_DB = {
  nextOrderSeq: 1,
  settings: {
    shop_phone: '8866925561',
    require_device_approval: false,
    templates: DEFAULT_TEMPLATES,
    sticker_width_mm: 60,
    sticker_height_mm: 40,
    pins: { admin: '1234', sales: '1111', cutting: '2222', tailor_1: '3333', tailor_2: '4444' },
    tailorRates: { tailor_1: 150, tailor_2: 150 },
    stageAlertHours: { 'Cutting Pending': 24, 'With Tailor': 48, 'Silai Done': 12, 'Ready': 72 }
  },
  salesmen: ['Parthiv', 'Suresh Bhai', 'Jignesh Bhai'],
  devices: [],
  orders: [],
  pieceLogs: [],
  activityLogs: [],
  important_notes: []
};

// Shape Definitions
const SHAPE_DEFS = {
  None: [],
  Straight: [{ key: 'length', label: 'Front Length', defaultVal: '72' }, { key: 'depth', label: 'Depth', defaultVal: '30' }],
  'L-shape': [{ key: 'main_length', label: 'Main Back (A)', defaultVal: '102' }, { key: 'left_return', label: 'L Return (B)', defaultVal: '78' }, { key: 'depth', label: 'Depth (C)', defaultVal: '36' }],
  'L-shape with a step': [{ key: 'main_length', label: 'Main Back (A)', defaultVal: '102' }, { key: 'left_return', label: 'L Return (B)', defaultVal: '84' }, { key: 'depth', label: 'Depth (C)', defaultVal: '36' }, { key: 'step_w', label: 'Step Cut Width', defaultVal: '12' }, { key: 'step_d', label: 'Step Cut Depth', defaultVal: '8' }],
  'U-shape': [{ key: 'left_len', label: 'Left Arm (A)', defaultVal: '78' }, { key: 'center_len', label: 'Center Back (B)', defaultVal: '108' }, { key: 'right_len', label: 'Right Arm (C)', defaultVal: '78' }, { key: 'depth', label: 'Depth', defaultVal: '36' }],
  Corner: [{ key: 'side_a', label: 'Left Side (A)', defaultVal: '90' }, { key: 'side_b', label: 'Right Side (B)', defaultVal: '90' }, { key: 'corner_w', label: 'Corner Wedge', defaultVal: '38' }],
  'Curved corner': [{ key: 'side_a', label: 'Left Side (A)', defaultVal: '96' }, { key: 'side_b', label: 'Right Side (B)', defaultVal: '96' }, { key: 'radius', label: 'Curve Radius', defaultVal: '36' }]
};

function ShapeSVG({ shape }) {
  if (!shape || shape.template === 'None') return null;
  const unit = shape.unit === 'ft' ? 'ft' : '"';
  const s = shape.sides || {};
  const lbl = k => `${s[k] || '0'}${unit}`;
  let paths = '';
  
  if (shape.template === 'Straight') {
    paths = `<rect x="40" y="55" width="220" height="70" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="150" y="45" text-anchor="middle" font-size="12" font-weight="bold">Length: ${lbl('length')}</text><text x="270" y="95" text-anchor="start" font-size="12" font-weight="bold">${lbl('depth')}</text>`;
  } else if (shape.template === 'L-shape') {
    paths = `<polygon points="40,35 250,35 250,90 105,90 105,155 40,155" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('main_length')}</text><text x="12" y="100" text-anchor="start" font-size="12" font-weight="bold">B: ${lbl('left_return')}</text><text x="255" y="68" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('depth')}</text>`;
  } else if (shape.template === 'L-shape with a step') {
    paths = `<polygon points="40,35 250,35 250,90 105,90 105,135 80,135 80,158 40,158" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('main_length')}</text><text x="10" y="98" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('left_return')}</text><text x="254" y="66" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('depth')}</text><text x="115" y="150" text-anchor="start" font-size="11" font-weight="bold">Step: ${lbl('step_w')}×${lbl('step_d')}</text>`;
  } else if (shape.template === 'U-shape') {
    paths = `<polygon points="35,30 265,30 265,155 210,155 210,80 90,80 90,155 35,155" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="150" y="22" text-anchor="middle" font-size="12" font-weight="bold">B: ${lbl('center_len')}</text><text x="8" y="95" text-anchor="start" font-size="11" font-weight="bold">A: ${lbl('left_len')}</text><text x="270" y="95" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('right_len')}</text><text x="150" y="100" text-anchor="middle" font-size="11">Depth: ${lbl('depth')}</text>`;
  } else if (shape.template === 'Corner') {
    paths = `<polygon points="40,35 245,35 245,88 115,88 90,115 90,160 40,160" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('side_a')}</text><text x="10" y="105" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('side_b')}</text><text x="145" y="115" text-anchor="start" font-size="11" font-weight="bold">Corner: ${lbl('corner_w')}</text>`;
  } else if (shape.template === 'Curved corner') {
    paths = `<path d="M 40,160 L 40,85 Q 40,35 95,35 L 250,35 L 250,88 L 110,88 Q 92,88 92,108 L 92,160 Z" fill="#f8fafc" stroke="#000" stroke-width="2.5"/><text x="155" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('side_a')}</text><text x="10" y="125" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('side_b')}</text><text x="145" y="115" text-anchor="start" font-size="11" font-weight="bold">Curve R: ${lbl('radius')}</text>`;
  }

  return (
    <svg viewBox="0 0 330 180" xmlns="http://www.w3.org/2000/svg" className="w-full h-auto max-w-xs mx-auto">
      <text x="165" y="175" text-anchor="middle" font-size="11" fill="#333">Shape: {shape.template}</text>
      <g dangerouslySetInnerHTML={{ __html: paths }} />
    </svg>
  );
}
