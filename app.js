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
// =========================================================================
// STICKER PRINT MODAL (Handles Legacy + New Lines & SVG Shape)
// =========================================================================
function StickerPrintModal({ ordersList, settings, onClose, onLogReprint }) {
  const w = settings?.sticker_width_mm || 60;
  const h = settings?.sticker_height_mm || 40;

  const handlePrint = () => {
    const style = document.createElement('style');
    style.innerHTML = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
    document.head.appendChild(style);
    ordersList.forEach((ord) => onLogReprint && onLogReprint(ord));
    window.print();
    document.head.removeChild(style);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-md border border-gray-300 max-w-lg w-full p-4 md:p-5 shadow-lg">
        <div className="flex justify-between items-center border-b border-gray-200 pb-3 mb-4">
          <div>
            <h3 className="font-bold text-base text-gray-900">
              {ordersList.length > 1 ? `Batch Cutting Stickers (${ordersList.length} Orders)` : `Cutting Sticker — ${ordersList[0].order_no}`}
            </h3>
            <p className="text-xs text-gray-500">Label size: {w} × {h} mm • Thermal / PDF ready</p>
          </div>
          <button onClick={onClose} className="p-2 min-w-[44px] min-h-[44px] text-gray-500 hover:bg-gray-100 rounded inline-flex items-center justify-center">
            <Icon name="X" size={18} />
          </button>
        </div>

        <div id="printable-area" className="max-h-80 overflow-y-auto bg-gray-100 p-4 rounded border border-gray-200 space-y-3 mb-4">
          {ordersList.map((order) => {
            const hasLines = Array.isArray(order.lines) && order.lines.length > 0;
            const qrUrl = `${window.location.origin}${window.location.pathname}?scan=${order.order_no}`;
            const qrImgSrc = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=0&data=${encodeURIComponent(qrUrl)}`;
            
            return (
              <div
                key={order.id}
                style={{ width: `${w}mm`, height: `${h}mm`, pageBreakAfter: 'always' }}
                className="bg-white border border-black p-1 flex flex-col justify-between text-black leading-tight overflow-hidden mx-auto"
              >
                <div className="flex justify-between items-start border-b border-black pb-0.5">
                  <div>
                    <div className="font-bold text-sm tracking-tight">{order.order_no}</div>
                    <div className="text-[9px] font-semibold truncate max-w-[34mm]">{order.design_name || (order.lines?.[0]?.design)}</div>
                  </div>
                  <img src={qrImgSrc} alt="QR" className="w-[9mm] h-[9mm]" />
                </div>
                
                <div className="text-[8px] space-y-0.5 my-0.5 overflow-hidden">
                  {hasLines ? (
                    order.lines.map((l, i) => {
                      const c = calcEstimate({lines: [l]}).lines[0];
                      const isPend = l.measurement_pending;
                      return (
                        <div key={i} className={`${isPend ? 'bg-gray-200 font-bold border border-black px-0.5' : ''}`}>
                          <strong>{getLinePartName(l).substring(0,6)}:</strong> {c.segJoined} 
                          ({l.unit === 'pcs' ? `${c.pcs}p` : `${c.feet.toFixed(2)}f`})
                          {isPend ? ' [PENDING]' : ''}
                        </div>
                      );
                    })
                  ) : (
                    <>
                      <div><strong>S:</strong> {order.seating_segments} = <b>{order.seating_feet}ft</b></div>
                      <div><strong>B:</strong> {order.back_segments} = <b>{order.back_billable_qty}{order.back_unit === 'Inches' ? 'ft' : 'pcs'}</b></div>
                    </>
                  )}
                  
                  {order.shape && order.shape.template !== 'None' && (
                    <div className="text-center mt-1"><ShapeSVG shape={order.shape} /></div>
                  )}

                  {order.special_cuts && order.special_cuts.length > 0 && (
                    <div className="border border-black p-0.5 mt-0.5 font-bold">
                      CUTS: {order.special_cuts.map(sc => `${sc.cut_type}(${sc.size})`).join(', ')}
                    </div>
                  )}

                  {order.tailor_notes && (
                    <div className="truncate italic border-t border-dashed border-gray-500 pt-0.5">
                      Note: {order.tailor_notes}
                    </div>
                  )}
                </div>
                
                <div className="text-[8px] font-bold border-t border-black pt-0.5 flex justify-between">
                  <span>DEL: {formatDateDDMMYYYY(order.promised_date)}</span>
                  <span>PCS: {order.total_pcs}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <button onClick={handlePrint} className="flex-1 bg-amber-700 hover:bg-amber-800 text-white py-2.5 px-4 rounded font-semibold text-sm inline-flex items-center justify-center gap-2 min-h-[44px]">
            <Icon name="Printer" size={16} /> Print {ordersList.length > 1 ? `All (${ordersList.length})` : 'Sticker'}
          </button>
          <button onClick={onClose} className="border border-gray-300 hover:bg-gray-50 text-gray-800 py-2.5 px-4 rounded font-semibold text-sm inline-flex items-center justify-center gap-2 min-h-[44px]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// ORDER TIMELINE MODAL
// =========================================================================
function OrderTimelineModal({ order, activityLogs, onClose }) {
  const logs = activityLogs.filter((l) => l.order_no === order.order_no);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-md border border-gray-300 max-w-lg w-full p-4 md:p-5 shadow-lg">
        <div className="flex justify-between items-center border-b border-gray-200 pb-3 mb-4">
          <div>
            <h3 className="font-bold text-base text-gray-900">Order Audit Timeline — {order.order_no}</h3>
            <p className="text-xs text-gray-500">{order.customer_name}</p>
          </div>
          <button onClick={onClose} className="p-2 min-w-[44px] min-h-[44px] text-gray-500 hover:bg-gray-100 rounded inline-flex items-center justify-center">
            <Icon name="X" size={18} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto space-y-3">
          {logs.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No activity events logged for this order yet.</p>
          ) : (
            logs.map((l) => (
              <div key={l.id} className="flex items-start gap-3 border-l-2 border-amber-600 pl-3 py-1">
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">{l.action}</div>
                  <div className="text-xs text-gray-500">
                    By <span className="font-semibold uppercase">{l.role}</span> • {formatDateTimeDDMMYYYY(l.created_at)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// ONE-SCREEN ORDER ENTRY + REVIEW & CONFIRM FLOW (V6 UPGRADED)
// =========================================================================
function OrderEntryScreen({ existingOrder, allOrders, salesmen, currentRole, onCancel, onCommitOrder }) {
  const isConfirmed = existingOrder && !['Measurement Pending', 'Estimate Given'].includes(existingOrder.status);
  const canEditSpecs = !isConfirmed || currentRole === 'admin';

  const draftKey = existingOrder ? `sg_draft_${existingOrder.id}` : 'sg_draft_new_order_v6';

  const [form, setForm] = useState(() => {
    if (!existingOrder) {
      const savedDraft = localStorage.getItem(draftKey);
      if (savedDraft) {
        try { return JSON.parse(savedDraft); } catch (e) {}
      }
    }
    
    // Convert legacy fields to new lines structure if needed
    let initialLines = existingOrder?.lines || [];
    if (initialLines.length === 0) {
      if (existingOrder?.seating_segments || existingOrder?.back_segments) {
        initialLines.push({ id: crypto.randomUUID(), part: 'Seating', design: existingOrder.design_name || '', rate: existingOrder.seating_rate || '', unit: 'inches_ft', measurement_pending: false, segments: [{ id: crypto.randomUUID(), length_expr: existingOrder.seating_segments, width: '', label: '' }] });
        if (existingOrder.back_segments) {
          initialLines.push({ id: crypto.randomUUID(), part: 'Back', design: existingOrder.design_name || '', rate: existingOrder.back_rate || '', unit: existingOrder.back_unit === 'Pcs' ? 'pcs' : 'inches_ft', measurement_pending: false, segments: [{ id: crypto.randomUUID(), length_expr: existingOrder.back_segments, width: '', label: '' }] });
        }
      } else {
        initialLines.push({ id: crypto.randomUUID(), part: 'Seating', custom_part: '', design: '', rate: '', unit: 'inches_ft', measurement_pending: false, segments: [{ id: crypto.randomUUID(), length_expr: '', width: '', label: '' }] });
      }
    }

    return {
      customer_name: existingOrder?.customer_name || '',
      mobile: existingOrder?.mobile || '',
      address: existingOrder?.address || '',
      home_delivery: existingOrder?.home_delivery || false,
      measurement_source: existingOrder?.measurement_source || 'Customer brought',
      visit_staff_name: existingOrder?.visit_staff_name || '',
      visit_charge: existingOrder?.visit_charge || 0,
      
      lines: initialLines,
      shape: existingOrder?.shape || { template: 'None', unit: 'in', sides: {} },
      special_cuts: existingOrder?.special_cuts || [],
      sketch_photo: existingOrder?.sketch_photo || null,
      important_note: existingOrder?.important_note || '',
      important_note_priority: existingOrder?.important_note_priority || 'Normal',

      // Keep legacy for safety/printing
      design_name: existingOrder?.design_name || (initialLines[0]?.design || ''),
      total_pcs: existingOrder?.total_pcs || '',
      
      advance_amount: existingOrder?.advance_amount || 0,
      payment_mode: existingOrder?.payment_mode || 'Cash',
      salesman_name: existingOrder?.salesman_name || (salesmen[0] || ''),
      promised_date: existingOrder?.promised_date || ''
    };
  });

  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!existingOrder) {
      localStorage.setItem(draftKey, JSON.stringify(form));
      setDraftSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }
  }, [form]);

  const matchingPastOrders = useMemo(() => {
    const cleanMob = String(form.mobile || '').replace(/\D/g, '');
    if (cleanMob.length < 10) return [];
    return allOrders.filter(
      (o) => String(o.mobile || '').replace(/\D/g, '').endsWith(cleanMob.slice(-10)) && o.id !== existingOrder?.id
    );
  }, [form.mobile, allOrders]);

  const handleMobileChange = (val) => {
    const clean = val.replace(/\D/g, '').slice(0, 10);
    const updates = { mobile: clean };
    if (clean.length === 10) {
      const prev = allOrders.find((o) => String(o.mobile || '').replace(/\D/g, '').endsWith(clean));
      if (prev) {
        if (!form.customer_name) updates.customer_name = prev.customer_name;
        if (!form.address && prev.address) updates.address = prev.address;
      }
    }
    setForm((f) => ({ ...f, ...updates }));
  };

  const calc = calcEstimate(form);

  // Line & Segment Management
  const addLine = () => {
    const usedWidths = getUsedWidths();
    const lastW = usedWidths.length > 0 ? usedWidths[usedWidths.length - 1] : '';
    setForm(f => ({
      ...f, 
      lines: [...f.lines, { id: crypto.randomUUID(), part: 'Seating', custom_part: '', design: f.design_name, rate: '', unit: 'inches_ft', measurement_pending: false, segments: [{ id: crypto.randomUUID(), length_expr: '', width: lastW, label: '' }] }]
    }));
  };

  const removeLine = (idx) => {
    if (form.lines.length <= 1) return alert('At least 1 line is required.');
    const newLines = [...form.lines];
    newLines.splice(idx, 1);
    setForm(f => ({ ...f, lines: newLines }));
  };

  const addSegment = (lIdx) => {
    const newLines = [...form.lines];
    const line = newLines[lIdx];
    const lastW = line.segments.length > 0 ? line.segments[line.segments.length-1].width : '';
    line.segments.push({ id: crypto.randomUUID(), length_expr: '', width: lastW, label: '' });
    setForm(f => ({ ...f, lines: newLines }));
  };

  const removeSegment = (lIdx, sIdx) => {
    const newLines = [...form.lines];
    if (newLines[lIdx].segments.length <= 1) return;
    newLines[lIdx].segments.splice(sIdx, 1);
    setForm(f => ({ ...f, lines: newLines }));
  };

  const updateLine = (lIdx, field, val) => {
    const newLines = [...form.lines];
    newLines[lIdx][field] = val;
    setForm(f => ({ ...f, lines: newLines, design_name: lIdx === 0 && field === 'design' ? val : f.design_name }));
  };

  const updateSegment = (lIdx, sIdx, field, val) => {
    const newLines = [...form.lines];
    newLines[lIdx].segments[sIdx][field] = val;
    setForm(f => ({ ...f, lines: newLines }));
  };

  const getUsedWidths = () => {
    const wSet = new Set();
    form.lines.forEach(l => l.segments.forEach(s => { if(s.width) wSet.add(s.width); }));
    return Array.from(wSet);
  };

  const applyWidthChip = (lIdx, widthVal) => {
    const newLines = [...form.lines];
    const line = newLines[lIdx];
    let applied = false;
    for (let s of line.segments) {
      if (!s.width) { s.width = widthVal; applied = true; }
    }
    if (!applied && line.segments.length > 0) line.segments[line.segments.length-1].width = widthVal;
    setForm(f => ({ ...f, lines: newLines }));
  };

  // Special Cuts
  const addSpecialCut = () => setForm(f => ({ ...f, special_cuts: [...f.special_cuts, { id: crypto.randomUUID(), cut_type: 'Step cut', line_ref: 'Line #1', size: '', note: '' }] }));
  const removeSpecialCut = (idx) => {
    const sc = [...form.special_cuts];
    sc.splice(idx, 1);
    setForm(f => ({ ...f, special_cuts: sc }));
  };
  const updateSpecialCut = (idx, field, val) => {
    const sc = [...form.special_cuts];
    sc[idx][field] = val;
    setForm(f => ({ ...f, special_cuts: sc }));
  };

  // Photo
  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setForm(f => ({ ...f, sketch_photo: ev.target.result }));
    reader.readAsDataURL(file);
  };

  const validateAndOpenReview = () => {
    setErrorMsg('');
    if (!form.customer_name.trim() || form.mobile.length < 10) return setErrorMsg('Customer Name and 10-digit Mobile required.');
    if (!form.salesman_name || !form.promised_date || !form.total_pcs) return setErrorMsg('Salesman, Promised Date, and Total Pieces are required.');
    setReviewMode(true);
  };

  const finalizeSave = (targetStatus, afterAction = 'none') => {
    setErrorMsg('');
    if (!form.customer_name.trim() || !form.mobile.trim()) return setErrorMsg('Customer Name and Mobile required.');
    
    const nextStatus = targetStatus === 'Confirmed' ? 'Cutting Pending' : targetStatus;
    
    // Auto piece count if not set manually
    const autoPcs = form.lines.reduce((acc, l) => acc + (l.segments.length || 1), 0);
    
    const payload = {
      ...form,
      total_pcs: parseInt(form.total_pcs) || autoPcs || 1,
      estimate_total: calc.total,
      advance_amount: parseFloat(form.advance_amount) || 0,
      balance_amount: calc.balance,
      status: nextStatus
    };
    if (!existingOrder) localStorage.removeItem(draftKey);
    onCommitOrder(payload, targetStatus === 'Confirmed', afterAction);
  };

  const usedWidths = getUsedWidths();
  return (
    <div className="bg-white border border-gray-300 rounded-md shadow-sm">
      {/* Top Bar */}
      <div className="px-4 md:px-5 py-3.5 border-b border-gray-200 flex flex-wrap justify-between items-center gap-3 bg-gray-50">
        <div className="flex items-center gap-3">
          <button onClick={onCancel} className="px-3 py-2 border border-gray-300 bg-white hover:bg-gray-100 rounded text-xs font-semibold text-gray-700 inline-flex items-center gap-1.5 min-h-[44px] md:min-h-0">
            <Icon name="ArrowLeft" size={14} /> Back to Queue
          </button>
          <div>
            <h2 className="font-bold text-base text-gray-900">
              {existingOrder ? `Edit Order ${existingOrder.order_no}` : 'New Sofa Cover Order'}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!existingOrder && draftSavedAt && <span className="text-xs text-gray-500">Draft saved: {draftSavedAt}</span>}
          {!existingOrder && (
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(draftKey);
                setForm({ customer_name: '', mobile: '', address: '', home_delivery: false, measurement_source: 'Customer brought', visit_staff_name: '', visit_charge: 0, lines: [{ id: crypto.randomUUID(), part: 'Seating', custom_part: '', design: '', rate: '', unit: 'inches_ft', measurement_pending: false, segments: [{ id: crypto.randomUUID(), length_expr: '', width: '', label: '' }] }], shape: { template: 'None', unit: 'in', sides: {} }, special_cuts: [], sketch_photo: null, important_note: '', important_note_priority: 'Normal', design_name: '', total_pcs: '', advance_amount: 0, payment_mode: 'Cash', salesman_name: salesmen[0] || '', promised_date: '' });
              }}
              className="text-xs text-gray-600 hover:text-gray-900 underline py-2 px-1"
            >
              Clear Form
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="mx-4 md:mx-5 mt-4 p-3 bg-red-50 border border-red-300 text-red-800 rounded text-sm font-medium flex items-center gap-2">
          <Icon name="AlertCircle" size={16} /> {errorMsg}
        </div>
      )}

      <div className="p-4 md:p-5 grid grid-cols-1 lg:grid-cols-3 gap-5 md:gap-6">
        <div className="lg:col-span-2 space-y-5">
          {/* Section 1: Customer Details */}
          <div className="border border-gray-200 rounded p-3.5 md:p-4 space-y-3.5">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-500">1. Customer & Delivery Details</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Mobile Number (10 digits) *</label>
                <input autoFocus type="tel" placeholder="98250XXXXX" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={form.mobile} onChange={(e) => handleMobileChange(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Customer Name *</label>
                <input placeholder="Full Name" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Salesman *</label>
                <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.salesman_name} onChange={(e) => setForm({ ...form, salesman_name: e.target.value })}>
                  <option value="">Select Salesman</option>
                  {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 pt-1">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Measurement Source</label>
                <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.measurement_source} onChange={(e) => setForm({ ...form, measurement_source: e.target.value })}>
                  <option>Customer brought</option><option>Shop visit</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Promised Delivery Date *</label>
                <input type="date" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={form.promised_date} onChange={(e) => setForm({ ...form, promised_date: e.target.value })} />
              </div>
              <div className="flex items-center pt-1 md:pt-5">
                <label className="inline-flex items-center gap-2.5 cursor-pointer text-sm font-medium text-gray-800">
                  <input type="checkbox" className="w-5 h-5 accent-amber-700" checked={form.home_delivery} onChange={(e) => setForm({ ...form, home_delivery: e.target.checked })} /> Home Delivery Required
                </label>
              </div>
            </div>

            {(form.home_delivery || form.measurement_source === 'Shop visit' || form.address) && (
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Customer Address</label>
                <input placeholder="House/Flat No, Society, Area" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
            )}
            
            {/* FEATURE F: Important Notes */}
            <div className="bg-amber-50 border border-amber-200 rounded p-3 mt-2 grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="sm:col-span-3">
                <label className="block text-xs font-bold text-amber-900 mb-1">📌 Important Note (Shows on Dashboard)</label>
                <input placeholder="Optional urgent instruction..." className="w-full border border-amber-300 rounded px-3 py-2 text-sm" value={form.important_note} onChange={(e) => setForm({ ...form, important_note: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-bold text-amber-900 mb-1">Priority</label>
                <select className="w-full border border-amber-300 rounded px-3 py-2 text-sm bg-white" value={form.important_note_priority} onChange={(e) => setForm({ ...form, important_note_priority: e.target.value })}>
                  <option value="Normal">Normal</option><option value="Urgent">Urgent 🔴</option>
                </select>
              </div>
            </div>
          </div>

          {/* Section 2: Lines (Feature A) */}
          <div className="border border-gray-200 rounded p-3.5 md:p-4 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-500">2. Order Lines & Measurements</span>
              <button type="button" disabled={!canEditSpecs} onClick={addLine} className="px-3 py-1.5 bg-amber-700 text-white rounded text-xs font-bold min-h-[44px] md:min-h-0">+ Add line</button>
            </div>
            
            {usedWidths.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded p-2 flex flex-wrap gap-2 items-center text-xs">
                <span className="font-bold text-blue-800">Quick Widths:</span>
                {usedWidths.map(w => (
                  <button type="button" key={w} onClick={() => applyWidthChip(form.lines.length-1, w)} className="px-2 py-1 bg-white border border-blue-300 text-blue-700 rounded-full font-semibold hover:bg-blue-100">{w}"</button>
                ))}
              </div>
            )}

            {form.lines.map((line, lIdx) => {
              const c = calc.lines?.[lIdx] || {};
              const isPend = line.measurement_pending;
              return (
                <div key={line.id} className={`border p-3 rounded space-y-3 ${isPend ? 'bg-red-50 border-red-300' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="flex justify-between items-center">
                    <strong className="text-sm">Line #{lIdx + 1}</strong>
                    <div className="flex items-center gap-3">
                      <label className="text-xs font-bold text-red-700 flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={isPend} onChange={e => updateLine(lIdx, 'measurement_pending', e.target.checked)} /> Meas. Pending
                      </label>
                      <button type="button" onClick={() => removeLine(lIdx)} className="text-red-600 font-bold px-2 py-1 bg-white border rounded">X</button>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Part</label>
                      <select disabled={!canEditSpecs} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white" value={line.part} onChange={e => updateLine(lIdx, 'part', e.target.value)}>
                        <option>Seating</option><option>Back</option><option>Handle</option><option>Other</option>
                      </select>
                      {line.part === 'Other' && <input disabled={!canEditSpecs} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mt-1" placeholder="Custom part" value={line.custom_part} onChange={e => updateLine(lIdx, 'custom_part', e.target.value)} />}
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Design Name</label>
                      <input disabled={!canEditSpecs} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" value={line.design} onChange={e => updateLine(lIdx, 'design', e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Rate (₹)</label>
                      <input disabled={!canEditSpecs} type="number" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" value={line.rate} onChange={e => updateLine(lIdx, 'rate', e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Unit</label>
                      <select disabled={!canEditSpecs} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white" value={line.unit} onChange={e => updateLine(lIdx, 'unit', e.target.value)}>
                        <option value="inches_ft">Inches → ft</option><option value="pcs">Pcs</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-xs font-bold text-gray-700">Segments (Length | Width (opt) | Label)</label>
                    {line.segments.map((seg, sIdx) => (
                      <div key={seg.id} className="flex gap-2 items-center">
                        <input disabled={!canEditSpecs} placeholder="Length (e.g. 102+36)" className="flex-2 border border-gray-300 rounded px-2 py-1.5 text-sm w-full" value={seg.length_expr} onChange={e => updateSegment(lIdx, sIdx, 'length_expr', e.target.value)} />
                        <input disabled={!canEditSpecs} placeholder='W"' className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm w-20" value={seg.width} onChange={e => updateSegment(lIdx, sIdx, 'width', e.target.value)} />
                        <input disabled={!canEditSpecs} placeholder="Label" className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm w-24" value={seg.label} onChange={e => updateSegment(lIdx, sIdx, 'label', e.target.value)} />
                        <button type="button" disabled={!canEditSpecs} onClick={() => removeSegment(lIdx, sIdx)} className="px-2 py-1 border rounded bg-white text-red-600 font-bold">X</button>
                      </div>
                    ))}
                    <button type="button" disabled={!canEditSpecs} onClick={() => addSegment(lIdx)} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs font-semibold">+ Add Segment</button>
                  </div>
                  <div className="text-xs font-bold text-blue-900 bg-blue-100 p-2 rounded">{getLinePartName(line)}: {c.segJoined} | {c.calcDisplay}</div>
                </div>
              );
            })}
          </div>

          {/* Section 3: Shape & Special Cuts (Feature B) */}
          <div className="border border-gray-200 rounded p-3.5 md:p-4 space-y-4">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-500">3. Sofa Shape & Special Cuts</span>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Shape Template</label>
                    <select className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" value={form.shape.template} onChange={e => {
                      const tpl = e.target.value;
                      const defs = SHAPE_DEFS[tpl] || [];
                      const newSides = {};
                      defs.forEach(d => newSides[d.key] = d.defaultVal);
                      setForm(f => ({...f, shape: { template: tpl, unit: f.shape.unit, sides: newSides }}));
                    }}>
                      <option value="None">None</option>
                      {Object.keys(SHAPE_DEFS).filter(k=>k!=='None').map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <div className="w-24">
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Unit</label>
                    <select className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" value={form.shape.unit} onChange={e => setForm(f => ({...f, shape: {...f.shape, unit: e.target.value}}))}>
                      <option value="in">Inches</option><option value="ft">Feet</option>
                    </select>
                  </div>
                </div>
                
                {form.shape.template !== 'None' && (
                  <div className="grid grid-cols-2 gap-2">
                    {(SHAPE_DEFS[form.shape.template] || []).map(def => (
                      <div key={def.key}>
                        <label className="block text-[10px] font-bold text-gray-600 truncate">{def.label}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.shape.sides[def.key] || ''} onChange={e => setForm(f => ({...f, shape: {...f.shape, sides: {...f.shape.sides, [def.key]: e.target.value}}}))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-white border rounded p-2 flex items-center justify-center min-h-[120px]">
                <ShapeSVG shape={form.shape} />
              </div>
            </div>

            <div className="border-t pt-3 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">⚠️ Special Cuts</strong>
                <button type="button" onClick={addSpecialCut} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs font-semibold">+ Add Cut</button>
              </div>
              {form.special_cuts.map((sc, idx) => (
                <div key={sc.id} className="flex flex-wrap gap-2 items-center bg-yellow-50 p-2 rounded border border-yellow-200">
                  <select className="border border-gray-300 rounded px-2 py-1 text-xs" value={sc.cut_type} onChange={e => updateSpecialCut(idx, 'cut_type', e.target.value)}>
                    {['Step cut','Notch around leg/pillar','Curved corner','Recliner','Chaise','Round arm','Other'].map(o => <option key={o}>{o}</option>)}
                  </select>
                  <input placeholder="Line Ref" className="border border-gray-300 rounded px-2 py-1 text-xs w-24" value={sc.line_ref} onChange={e => updateSpecialCut(idx, 'line_ref', e.target.value)} />
                  <input placeholder="Size" className="border border-gray-300 rounded px-2 py-1 text-xs w-20" value={sc.size} onChange={e => updateSpecialCut(idx, 'size', e.target.value)} />
                  <input placeholder="Note" className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 min-w-[100px]" value={sc.note} onChange={e => updateSpecialCut(idx, 'note', e.target.value)} />
                  <button type="button" onClick={() => removeSpecialCut(idx)} className="px-2 py-1 bg-white border rounded text-red-600 font-bold">X</button>
                </div>
              ))}
            </div>

            <div className="border-t pt-3">
              <label className="block text-xs font-semibold text-gray-700 mb-1">📷 Attach Sketch Photo (Internal Only)</label>
              <input type="file" accept="image/*" onChange={handlePhoto} className="w-full text-sm" />
              {form.sketch_photo && <img src={form.sketch_photo} className="mt-2 h-20 border rounded object-contain" alt="Sketch" />}
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">General Tailor Notes (Printed on Sticker)</label>
              <textarea rows={2} className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={form.tailor_notes} onChange={(e) => setForm({ ...form, tailor_notes: e.target.value })} />
            </div>
          </div>
        </div>

        {/* Right Column: Live Estimate Summary */}
        <div className="bg-gray-50 border border-gray-300 rounded p-4 flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="border-b border-gray-300 pb-2 flex justify-between items-center">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-700">Estimate Summary</span>
              <span className="text-xs font-semibold text-gray-500">FIXED RATE</span>
            </div>

            <div className="space-y-2 text-sm">
              {Array.isArray(calc.lines) && calc.lines.length > 0 ? (
                calc.lines.map((l, i) => (
                  <div key={i} className="flex justify-between border-b border-gray-200 pb-1">
                    <span className="text-gray-600 truncate mr-2">{getLinePartName(l)}</span>
                    <span className="font-semibold">{formatINR(l.amount)}</span>
                  </div>
                ))
              ) : (
                <>
                  <div className="flex justify-between border-b pb-1"><span className="text-gray-600">Seating</span><span className="font-semibold">{formatINR(calc.seatingAmount)}</span></div>
                  <div className="flex justify-between border-b pb-1"><span className="text-gray-600">Back</span><span className="font-semibold">{formatINR(calc.backAmount)}</span></div>
                </>
              )}
            </div>
            <div className="flex justify-between font-bold text-lg pt-2"><span>Total</span><span>{formatINR(calc.total)}</span></div>

            <div className="pt-2 space-y-3 border-t border-gray-300">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Total Piece Count (Auto or Manual)</label>
                <input type="number" className="w-full border border-gray-300 bg-white rounded px-3 py-2 text-base font-bold text-gray-900" value={form.total_pcs} placeholder="Leave blank to auto-count segments" onChange={(e) => setForm({ ...form, total_pcs: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Advance Received (₹)</label>
                <input type="number" className="w-full border border-gray-300 bg-white rounded px-3 py-2 text-base font-bold text-gray-900" value={form.advance_amount} onChange={(e) => setForm({ ...form, advance_amount: e.target.value })} />
              </div>
              <div className="bg-white border border-gray-300 rounded p-3 flex justify-between items-center tabular-nums">
                <span className="text-xs font-bold uppercase text-gray-600">Balance Due</span>
                <span className={`text-lg font-bold ${calc.balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{formatINR(calc.balance)}</span>
              </div>
            </div>
          </div>
<div className="space-y-2.5 pt-3 border-t border-gray-300">
            {(!existingOrder || ['Measurement Pending', 'Estimate Given'].includes(existingOrder.status)) ? (
              <>
                <button type="button" onClick={() => finalizeSave('Estimate Given', 'none')} className="w-full bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 py-3 rounded font-semibold text-sm min-h-[44px]">
                  Save as Unconfirmed Estimate
                </button>
                <button type="button" onClick={validateAndOpenReview} className="w-full bg-amber-700 hover:bg-amber-800 text-white py-3 rounded font-bold text-sm inline-flex items-center justify-center gap-2 min-h-[44px]">
                  Review & Confirm Order <Icon name="ArrowRight" size={16} />
                </button>
              </>
            ) : (
              <button type="button" onClick={() => finalizeSave(existingOrder.status, 'none')} className="w-full bg-gray-900 hover:bg-gray-800 text-white py-3 rounded font-bold text-sm min-h-[44px]">
                Save Order Changes
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Review Modal with 3 Required Buttons */}
      {reviewMode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md border border-gray-300 max-w-xl w-full p-5 md:p-6 shadow-xl space-y-4">
            <div className="flex justify-between items-center border-b border-gray-200 pb-3">
              <h3 className="font-bold text-lg text-gray-900">Final Review Before Confirmation</h3>
              <button onClick={() => setReviewMode(false)} className="text-gray-500 hover:bg-gray-100 p-2 rounded min-w-[44px] min-h-[44px] inline-flex items-center justify-center"><Icon name="X" size={18} /></button>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded p-4 space-y-2 text-sm">
              <div className="flex justify-between gap-2"><span className="text-gray-600">Customer:</span><strong className="text-right">{form.customer_name} ({form.mobile})</strong></div>
              <div className="flex justify-between gap-2"><span className="text-gray-600">Design & Pieces:</span><strong className="text-right">{form.design_name} — {form.total_pcs || 'Auto'} Pcs</strong></div>
              
              <div className="border-t border-gray-200 my-2 pt-2 space-y-1">
                {form.lines.map((l, i) => (
                  <div key={i} className="flex justify-between gap-2 text-xs">
                    <span className="text-gray-600">{getLinePartName(l)}:</span>
                    <strong className="text-right">{calc.lines[i]?.segJoined} {l.measurement_pending ? '(PENDING)' : ''}</strong>
                  </div>
                ))}
              </div>

              <div className="flex justify-between gap-2 border-t pt-2 mt-2"><span className="text-gray-600">Promised Delivery:</span><strong className="text-right">{formatDateDDMMYYYY(form.promised_date)}</strong></div>
              <div className="border-t border-gray-300 pt-2 flex flex-wrap justify-between gap-2 text-base tabular-nums">
                <span>Total: <strong>{formatINR(calc.total)}</strong> | Adv: <strong>{formatINR(form.advance_amount)}</strong></span>
                <span className="text-red-700 font-bold">Bal: {formatINR(calc.balance)}</span>
              </div>
            </div>

            <div className="space-y-2.5 pt-2 grid grid-cols-1 gap-2">
              <button onClick={() => finalizeSave('Confirmed', 'sticker_wa')} className="w-full bg-emerald-700 hover:bg-emerald-800 text-white py-3 rounded font-bold text-sm flex items-center justify-center gap-2">
                ✅ Confirm + Sticker + WhatsApp Preview
              </button>
              <button onClick={() => finalizeSave('Confirmed', 'sticker_only')} className="w-full bg-amber-700 hover:bg-amber-800 text-white py-3 rounded font-bold text-sm flex items-center justify-center gap-2">
                🖨️ Confirm + Sticker Only
              </button>
              <button onClick={() => finalizeSave('Measurement Pending', 'none')} className="w-full bg-gray-200 hover:bg-gray-300 text-gray-900 py-3 rounded font-bold text-sm flex items-center justify-center gap-2">
                ⏳ Save as Pending
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// SHOP FLOOR VIEWS (Cutting / Tailor) - Includes Feature B special cut checks
// =========================================================================
function ShopFloorMobileView({ db, saveDb, currentRole, scannedOrderNo }) {
  const [selectedTailor, setSelectedTailor] = useState({});
  const [ackState, setAckState] = useState({});

  const queueOrders = useMemo(() => {
    return db.orders.filter(o => {
      if (o.is_archived || o.is_deleted) return false;
      if (currentRole === 'cutting') return o.status === 'Cutting Pending';
      if (currentRole.startsWith('tailor')) return o.status === 'With Tailor' && o.assigned_tailor === currentRole;
      return false;
    }).sort((a, b) => (a.promised_date || '9999-12-31').localeCompare(b.promised_date || '9999-12-31'));
  }, [db.orders, currentRole]);

  const handleCuttingComplete = (order) => {
    const tailor = selectedTailor[order.id];
    if (!tailor) return alert('Select Tailor 1 or 2 before confirming.');
    
    // Feature B Check
    if (order.special_cuts?.length > 0 && !ackState[order.id]) {
      return alert('⚠️ Please tick "I have read the special cut" before marking Cutting OK.');
    }

    if (!confirm(`Confirm cutting complete for ${order.order_no}?`)) return;
    
    const nowIso = new Date().toISOString();
    const nextOrders = db.orders.map(o => o.id === order.id ? { ...o, status: 'With Tailor', assigned_tailor: tailor, stage_changed_at: nowIso } : o);
    saveDb({ ...db, orders: nextOrders });
  };

  const handleStitchingComplete = (order) => {
    if (!confirm(`Confirm stitching complete for ${order.order_no}?`)) return;
    const nowIso = new Date().toISOString();
    const nextOrders = db.orders.map(o => o.id === order.id ? { ...o, status: 'Silai Done', stage_changed_at: nowIso } : o);
    saveDb({ ...db, orders: nextOrders });
  };

  return (
    <div className="max-w-xl mx-auto p-3 space-y-4">
      <div className="flex justify-between items-center px-1">
        <h2 className="font-bold text-base text-gray-900">
          {currentRole === 'cutting' ? `To Cut (${queueOrders.length})` : `To Stitch (${queueOrders.length})`}
        </h2>
      </div>

      {queueOrders.length === 0 ? (
        <div className="bg-white border rounded p-10 text-center font-bold text-gray-800">Queue is clear</div>
      ) : (
        queueOrders.map((order) => {
          const hasCuts = order.special_cuts?.length > 0;
          return (
            <div key={order.id} className="bg-white rounded border-2 border-gray-300 p-4 space-y-3">
              <div className="flex justify-between items-start border-b pb-2.5">
                <div>
                  <span className="font-bold text-lg">{order.order_no}</span>
                  <div className="text-base font-semibold">{order.design_name || order.lines?.[0]?.design}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold">{formatDateDDMMYYYY(order.promised_date)}</div>
                  <div className="text-xs font-bold text-amber-800">{order.total_pcs} PCS</div>
                </div>
              </div>

              {/* Display lines */}
              <div className="bg-gray-50 border rounded p-3 text-sm">
                {(order.lines || []).map((l, i) => (
                  <div key={i} className={l.measurement_pending ? 'text-red-700 font-bold' : ''}>
                    • {getLinePartName(l)}: {(calcEstimate({lines:[l]}).lines[0]?.segJoined)} {l.measurement_pending ? '[PENDING]' : ''}
                  </div>
                ))}
              </div>

              {/* Special Cuts Box */}
              {hasCuts && (
                <div className="special-cut-box p-3 rounded">
                  <h4 className="font-bold text-sm mb-1">⚠️ SPECIAL CUTS</h4>
                  {order.special_cuts.map(sc => <div key={sc.id} className="text-xs">• {sc.cut_type} ({sc.line_ref}): {sc.size} - {sc.note}</div>)}
                  {currentRole === 'cutting' && (
                    <label className="flex items-center gap-2 mt-2 font-bold cursor-pointer">
                      <input type="checkbox" className="w-4 h-4" checked={!!ackState[order.id]} onChange={e => setAckState({...ackState, [order.id]: e.target.checked})} />
                      I have read the special cut
                    </label>
                  )}
                </div>
              )}
              
              {order.sketch_photo && <img src={order.sketch_photo} className="mt-2 h-32 border rounded object-contain" alt="Sketch" />}

              {currentRole === 'cutting' && (
                <div className="space-y-2.5 pt-2">
                  <div className="grid grid-cols-2 gap-2">
                    {['tailor_1', 'tailor_2'].map((tKey) => (
                      <button key={tKey} onClick={() => setSelectedTailor({ ...selectedTailor, [order.id]: tKey })} className={`py-3 rounded border-2 font-bold ${selectedTailor[order.id] === tKey ? 'bg-gray-900 text-white border-gray-900' : 'bg-white'}`}>
                        {tKey === 'tailor_1' ? 'Tailor 1' : 'Tailor 2'}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => handleCuttingComplete(order)} className="w-full bg-amber-700 text-white py-4 rounded font-bold">
                    Confirm Cutting Done
                  </button>
                </div>
              )}

              {currentRole.startsWith('tailor') && (
                <button onClick={() => handleStitchingComplete(order)} className="w-full bg-emerald-700 text-white py-4 rounded font-bold mt-2">
                  Mark Stitching Done
                </button>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// =========================================================================
// MAIN DESKTOP ERP (Dashboard, Settings, Reports, Archive, Notes)
// =========================================================================
function DesktopERPView({ db, saveDb, currentRole, savedKey, onLogout, triggerInstall }) {
  const isAdmin = currentRole === 'admin';
  const [activeNav, setActiveNav] = useState('orders'); 
  const [queueFilter, setQueueFilter] = useState('ALL'); 
  const [searchQuery, setSearchQuery] = useState('');
  
  const [editingOrder, setEditingOrder] = useState(null);
  const [stickerBatch, setStickerBatch] = useState(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Settings State
  const [tplEdits, setTplEdits] = useState(db.settings.templates || DEFAULT_TEMPLATES);
  const [shopPhoneEdit, setShopPhoneEdit] = useState(db.settings.shop_phone || '8866925561');
  const [deviceApprEdit, setDeviceApprEdit] = useState(!!db.settings.require_device_approval);

  // Handle Note Completion
  const markNoteDone = (noteId) => {
    const newNotes = db.important_notes.map(n => n.id === noteId ? { ...n, is_done: true } : n);
    saveDb({ ...db, important_notes: newNotes });
  };

  // Order List Filters (Feature E: Archive/Trash views)
  const filteredOrders = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return db.orders.filter(o => {
      if (q && !(o.order_no?.toLowerCase().includes(q) || o.customer_name?.toLowerCase().includes(q) || o.mobile?.includes(q))) return false;
      
      if (queueFilter === 'ARCHIVED') return o.is_archived && !o.is_deleted;
      if (queueFilter === 'TRASH') return o.is_deleted;
      
      // Hide archived/trash from regular views
      if (o.is_archived || o.is_deleted) return false;

      if (queueFilter === 'READY_DELIVERY') return o.status === 'Ready';
      if (queueFilter === 'BALANCE_DUE') return !['Measurement Pending', 'Estimate Given'].includes(o.status) && Number(o.balance_amount) > 0;
      return true;
    }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [db.orders, searchQuery, queueFilter]);

  const handleAction = (order, type) => {
    const nowIso = new Date().toISOString();
    let nextOrders = [...db.orders];
    
    if (type === 'move_pending') {
      if (order.status === 'Pending') return;
      if (confirm(`Move ${order.order_no} back to Pending?`)) {
        nextOrders = nextOrders.map(o => o.id === order.id ? { ...o, status: 'Measurement Pending' } : o);
      }
    } else if (type === 'archive') {
      nextOrders = nextOrders.map(o => o.id === order.id ? { ...o, is_archived: true } : o);
    } else if (type === 'trash') {
      nextOrders = nextOrders.map(o => o.id === order.id ? { ...o, is_deleted: true, deleted_at: nowIso } : o);
    } else if (type === 'restore') {
      nextOrders = nextOrders.map(o => o.id === order.id ? { ...o, is_archived: false, is_deleted: false } : o);
    } else if (type === 'perm_delete') {
      const pin = prompt(`Type exact order number (${order.order_no}) to permanently delete:`);
      if (pin === order.order_no) nextOrders = nextOrders.filter(o => o.id !== order.id);
      else return alert('Order number did not match.');
    }
    
    saveDb({ ...db, orders: nextOrders });
  };

  const handleCommitOrder = (payload, wasConfirmed, afterAction) => {
    const nowIso = new Date().toISOString();
    let savedOrder;
    let nextOrders;
    let nextSeq = db.nextOrderSeq || 1;
    let newNotes = [...(db.important_notes || [])];

    if (editingOrder) {
      savedOrder = { ...editingOrder, ...payload, stage_changed_at: nowIso };
      nextOrders = db.orders.map(o => o.id === editingOrder.id ? savedOrder : o);
    } else {
      const orderNo = 'SC-' + String(nextSeq).padStart(4, '0');
      nextSeq += 1;
      savedOrder = { id: crypto.randomUUID(), order_no: orderNo, created_at: nowIso, stage_changed_at: nowIso, ...payload };
      nextOrders = [savedOrder, ...db.orders];
    }

    // Auto Note Generation (Feature F rules)
    if (payload.important_note) {
      newNotes.unshift({ id: crypto.randomUUID(), order_no: savedOrder.order_no, note: payload.important_note, priority: payload.important_note_priority, is_done: false, created_at: nowIso });
    }
    if (wasConfirmed && payload.advance_amount === 0) {
      newNotes.unshift({ id: crypto.randomUUID(), order_no: savedOrder.order_no, note: `Confirmed with Rs 0 Advance. Total: ${formatINR(payload.estimate_total)}`, priority: 'Urgent', is_done: false, created_at: nowIso });
    }

    saveDb({ ...db, nextOrderSeq: nextSeq, orders: nextOrders, important_notes: newNotes });
    setEditingOrder(null);
    setActiveNav('orders');

    if (afterAction === 'sticker_wa') {
      setStickerBatch([savedOrder]);
      window.open(WhatsAppService.getLink('receipt', savedOrder, db.settings.templates, db.settings.shop_phone), '_blank');
    } else if (afterAction === 'sticker_only') {
      setStickerBatch([savedOrder]);
    }
  };

  const activeNotes = (db.important_notes || []).filter(n => !n.is_done);

  return (
    <div className="min-h-screen flex flex-col w-full bg-gray-100 font-sans text-gray-900">
      {/* Header */}
      <header className="bg-gray-900 text-white px-4 py-3 flex justify-between items-center shadow-md">
        <div className="flex items-center gap-3">
          <button onClick={() => setMobileDrawerOpen(!mobileDrawerOpen)} className="md:hidden"><Icon name="Menu" size={24} /></button>
          <div className="font-bold text-lg">SG Furnishing Hub</div>
          <span className="hidden md:inline text-xs bg-gray-700 px-2 py-1 rounded">Role: {currentRole.toUpperCase()}</span>
        </div>
        <button onClick={onLogout} className="text-xs bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded font-bold">Logout</button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className={`${mobileDrawerOpen ? 'block absolute z-40 bg-white h-full shadow-2xl w-64' : 'hidden'} md:flex flex-col w-64 bg-white border-r p-4 space-y-2`}>
          <button onClick={() => { setEditingOrder(null); setActiveNav('new_order'); setMobileDrawerOpen(false); }} className="w-full bg-amber-700 hover:bg-amber-800 text-white py-2 rounded font-bold mb-4">
            + New Order
          </button>
          
          <button onClick={() => { setActiveNav('orders'); setQueueFilter('ALL'); setMobileDrawerOpen(false); }} className={`text-left p-2 rounded text-sm ${queueFilter === 'ALL' && activeNav === 'orders' ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100'}`}>
            🏠 Home & Orders
          </button>
          
          <button onClick={() => { setActiveNav('orders'); setQueueFilter('READY_DELIVERY'); setMobileDrawerOpen(false); }} className={`text-left p-2 rounded text-sm ${queueFilter === 'READY_DELIVERY' && activeNav === 'orders' ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100'}`}>
            📦 Ready for Delivery
          </button>

          {isAdmin && (
            <>
              <div className="pt-4 pb-1 text-xs font-bold text-gray-400 uppercase border-t mt-2">Admin</div>
              <button onClick={() => { setActiveNav('orders'); setQueueFilter('ARCHIVED'); setMobileDrawerOpen(false); }} className={`text-left p-2 rounded text-sm ${queueFilter === 'ARCHIVED' ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100'}`}>📦 Archived</button>
              <button onClick={() => { setActiveNav('orders'); setQueueFilter('TRASH'); setMobileDrawerOpen(false); }} className={`text-left p-2 rounded text-sm ${queueFilter === 'TRASH' ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100'}`}>🗑️ Trash</button>
              <button onClick={() => { setActiveNav('settings'); setMobileDrawerOpen(false); }} className={`text-left p-2 rounded text-sm ${activeNav === 'settings' ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100'}`}>⚙️ Settings</button>
            </>
          )}
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 p-4 overflow-y-auto">
          {/* Important Notes Board (Feature F) */}
          {activeNav === 'orders' && (queueFilter === 'ALL') && (
            <div className="mb-4 bg-yellow-50 border border-yellow-300 rounded p-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-yellow-900">📌 Important Notes Board</h3>
                <span className="bg-red-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">{activeNotes.length} Open</span>
              </div>
              {activeNotes.length === 0 ? <div className="text-sm text-gray-500">No active notes.</div> : (
                <div className="space-y-2">
                  {activeNotes.map(n => (
                    <div key={n.id} className={`p-2 rounded border flex justify-between items-center ${n.priority === 'Urgent' ? 'bg-red-50 border-red-200' : 'bg-white border-yellow-200'}`}>
                      <div className="text-sm"><strong>{n.order_no}</strong>: {n.note}</div>
                      <button onClick={() => markNoteDone(n.id)} className="bg-green-600 text-white px-2 py-1 rounded text-xs font-bold">Mark Done</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeNav === 'new_order' && (
            <OrderEntryScreen existingOrder={editingOrder} allOrders={db.orders} salesmen={db.salesmen} currentRole={currentRole} onCancel={() => setActiveNav('orders')} onCommitOrder={handleCommitOrder} />
          )}

          {activeNav === 'orders' && (
            <div className="bg-white border rounded shadow-sm">
              <div className="p-3 border-b bg-gray-50 flex gap-2">
                <input placeholder="Search orders..." className="border rounded px-3 py-2 text-sm flex-1 max-w-sm" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                <span className="py-2 text-sm font-bold text-gray-600 uppercase">{queueFilter.replace('_', ' ')}</span>
              </div>

              <div className="divide-y">
                {filteredOrders.length === 0 ? <div className="p-8 text-center text-gray-500">No orders found.</div> : (
                  filteredOrders.map(o => (
                    <div key={o.id} className="p-4 hover:bg-gray-50">
                      <div className="flex justify-between">
                        <div>
                          <strong className="text-lg">{o.order_no}</strong> — {o.customer_name} ({o.mobile})
                          <div className="text-sm text-gray-600">{o.design_name || (o.lines && o.lines[0]?.design)} | {o.total_pcs} Pcs</div>
                        </div>
                        <div className="text-right">
                          <StatusChip status={o.status} />
                          <div className="text-sm mt-1">Bal: <strong className={Number(o.balance_amount) > 0 ? 'text-red-600' : 'text-green-600'}>{formatINR(o.balance_amount)}</strong></div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {queueFilter === 'ARCHIVED' || queueFilter === 'TRASH' ? (
                          <>
                            <button onClick={() => handleAction(o, 'restore')} className="px-3 py-1 bg-green-600 text-white rounded text-xs font-bold">Restore</button>
                            {queueFilter === 'ARCHIVED' && <button onClick={() => handleAction(o, 'trash')} className="px-3 py-1 bg-red-100 text-red-700 rounded text-xs font-bold">Trash</button>}
                            {queueFilter === 'TRASH' && <button onClick={() => handleAction(o, 'perm_delete')} className="px-3 py-1 bg-red-600 text-white rounded text-xs font-bold">Delete Permanently</button>}
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingOrder(o); setActiveNav('new_order'); }} className="px-3 py-1.5 border rounded text-xs font-bold">Edit</button>
                            <button onClick={() => setStickerBatch([o])} className="px-3 py-1.5 border rounded text-xs font-bold">Sticker</button>
                            {isAdmin && o.status !== 'Measurement Pending' && <button onClick={() => handleAction(o, 'move_pending')} className="px-3 py-1.5 border rounded text-xs">Back to Pending</button>}
                            {isAdmin && <button onClick={() => handleAction(o, 'archive')} className="px-3 py-1.5 border rounded text-xs text-gray-600">Archive</button>}
                            {isAdmin && <button onClick={() => handleAction(o, 'trash')} className="px-3 py-1.5 border rounded text-xs text-red-600">Trash</button>}
                            <a href={WhatsAppService.getLink('receipt', o, db.settings.templates, db.settings.shop_phone)} target="_blank" rel="noreferrer" className="px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-bold">WA</a>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {isAdmin && activeNav === 'settings' && (
            <div className="space-y-4">
              <div className="bg-white p-4 border rounded">
                <h3 className="font-bold text-lg mb-4">⚙️ General Settings & Device Approval</h3>
                <div className="grid grid-cols-2 gap-4 max-w-lg mb-4">
                  <div>
                    <label className="block text-xs font-bold mb-1">Shop Phone (for WA Link)</label>
                    <input className="border rounded px-3 py-2 w-full text-sm" value={shopPhoneEdit} onChange={e => setShopPhoneEdit(e.target.value)} />
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 border rounded w-max mb-4">
                  <label className="font-bold text-sm">Require Device Approval for Staff Login?</label>
                  <input type="checkbox" className="w-5 h-5 cursor-pointer" checked={deviceApprEdit} onChange={(e) => {
                    const checked = e.target.checked;
                    setDeviceApprEdit(checked);
                    if (checked) {
                      // Auto approve existing devices so nobody is locked out
                      saveDb({ ...db, settings: { ...db.settings, require_device_approval: true }, devices: db.devices.map(d => ({...d, status: 'approved'})) });
                      alert('Turned ON. All currently active devices auto-approved.');
                    } else {
                      saveDb({ ...db, settings: { ...db.settings, require_device_approval: false } });
                    }
                  }} />
                </div>
                
                <h4 className="font-bold text-sm mb-2">Registered Devices</h4>
                <div className="border rounded divide-y max-w-xl">
                  {db.devices.map(d => (
                    <div key={d.fp} className="p-2 flex justify-between items-center text-sm">
                      <span>{d.fp} ({d.role.toUpperCase()}) - <strong>{d.status}</strong></span>
                      <div className="flex gap-2">
                        {d.status !== 'approved' && <button onClick={() => saveDb({...db, devices: db.devices.map(x => x.fp === d.fp ? {...x, status: 'approved'} : x)})} className="bg-green-600 text-white px-2 py-1 rounded text-xs font-bold">Approve</button>}
                        <button onClick={() => saveDb({...db, devices: db.devices.filter(x => x.fp !== d.fp)})} className="bg-red-100 text-red-600 px-2 py-1 rounded text-xs font-bold">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white p-4 border rounded">
                <h3 className="font-bold text-lg mb-4">💬 WhatsApp Templates Editor</h3>
                <div className="space-y-4">
                  {['estimate', 'receipt', 'ready', 'reminder', 'delivered'].map(key => (
                    <div key={key} className="bg-gray-50 p-3 border rounded">
                      <div className="flex justify-between items-center mb-2">
                        <strong className="capitalize">{key} Template</strong>
                        <select className="border rounded px-2 py-1 text-xs" value={tplEdits[key]?.lang || 'Hinglish'} onChange={e => setTplEdits({...tplEdits, [key]: {...tplEdits[key], lang: e.target.value}})}>
                          <option>Hinglish</option><option>English</option><option>Hindi</option>
                        </select>
                      </div>
                      <textarea rows={4} className="w-full border rounded p-2 text-sm" value={tplEdits[key]?.text || ''} onChange={e => setTplEdits({...tplEdits, [key]: {...tplEdits[key], text: e.target.value}})} />
                    </div>
                  ))}
                  <div className="flex gap-3">
                    <button onClick={() => { saveDb({...db, settings: {...db.settings, templates: tplEdits, shop_phone: shopPhoneEdit}}); alert('Templates and Phone saved.'); }} className="bg-gray-900 text-white px-4 py-2 rounded font-bold text-sm">Save All Settings</button>
                    <button onClick={() => setTplEdits(DEFAULT_TEMPLATES)} className="border px-4 py-2 rounded font-bold text-sm hover:bg-gray-50">Reset Default Hinglish</button>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">Placeholders: {"{customer}, {order_no}, {lines}, {total}, {advance}, {balance}, {promised_date}, {shop_phone}"}</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      
      {stickerBatch && (
        <StickerPrintModal ordersList={stickerBatch} settings={db.settings} onClose={() => setStickerBatch(null)} />
      )}
    </div>
  );
}

// =========================================================================
// MAIN APP COMPONENT (Auth & Core Logic)
// =========================================================================
function App() {
  const [db, setDb] = useState(() => {
    const cached = localStorage.getItem('sg_cloud_db_cache');
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    return INITIAL_DB;
  });
  
  const [currentRole, setCurrentRole] = useState(() => sessionStorage.getItem('sg_active_role') || null);
  const [selectedRole, setSelectedRole] = useState('sales');
  const [pin, setPin] = useState('');
  
  const myFp = getDeviceFingerprint();

  const handleLogin = (e) => {
    e.preventDefault();
    const expectedPin = db.settings?.pins?.[selectedRole] || (selectedRole === 'admin' ? '1234' : '1111');
    if (pin !== expectedPin) return alert('Incorrect PIN.');
    
    // Feature D: Device Approval Gate
    if (db.settings?.require_device_approval) {
      const dev = db.devices.find(d => d.fp === myFp);
      if (!dev || dev.status !== 'approved') {
        if (!dev) setDb(prev => { const n = {...prev, devices: [...prev.devices, {fp: myFp, role: selectedRole, status: 'pending'}]}; localStorage.setItem('sg_cloud_db_cache', JSON.stringify(n)); return n; });
        return alert(`Device Approval Pending. ID: ${myFp}`);
      }
    }

    sessionStorage.setItem('sg_active_role', selectedRole);
    setCurrentRole(selectedRole);
    setPin('');
  };

  const saveDb = (nextDb) => {
    setDb(nextDb);
    localStorage.setItem('sg_cloud_db_cache', JSON.stringify(nextDb));
    // Assuming backend sync logic fires here to Supabase bucket in production
  };

  if (!currentRole) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white border rounded-md p-6 max-w-sm w-full shadow-lg">
          <h1 className="font-bold text-xl mb-1 text-center">Shree Gayatri</h1>
          <p className="text-xs text-gray-500 text-center mb-6">Sofa Cover ERP v6</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <select className="w-full border rounded px-3 py-2 text-sm bg-white" value={selectedRole} onChange={e => setSelectedRole(e.target.value)}>
              <option value="admin">Owner (Admin)</option><option value="sales">Sales Counter</option>
              <option value="cutting">Cutting Master</option><option value="tailor_1">Tailor 1</option><option value="tailor_2">Tailor 2</option>
            </select>
            <input type="password" placeholder="PIN" className="w-full border rounded px-3 py-2 text-center text-xl tracking-widest font-bold" value={pin} onChange={e => setPin(e.target.value)} />
            <button className="w-full bg-gray-900 text-white py-3 rounded font-bold text-sm">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  if (['admin', 'sales'].includes(currentRole)) {
    return <DesktopERPView db={db} saveDb={saveDb} currentRole={currentRole} onLogout={() => setCurrentRole(null)} />;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-gray-900 text-white px-4 py-3 flex justify-between">
        <div><div className="font-bold text-sm">Shree Gayatri</div><div className="text-xs text-amber-400 uppercase">{currentRole.replace('_', ' ')}</div></div>
        <button onClick={() => setCurrentRole(null)} className="bg-gray-800 px-3 py-2 rounded text-xs font-semibold">Logout</button>
      </header>
      <ShopFloorMobileView db={db} saveDb={saveDb} currentRole={currentRole} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
