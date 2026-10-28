import { Router, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { jsPDF } from 'jspdf';
import { db } from '../lib/db';

const router = Router();

function getConfig(firmId:string){
  const rows=db.prepare("SELECT settingKey,settingValue FROM firm_settings WHERE firmId=? AND settingType='email' ").all(firmId) as any[];
  const c:any={}; for(const r of rows)c[r.settingKey]=r.settingValue;
  return c;
}
function saveConfig(firmId:string,cfg:any){
  const now=new Date().toISOString();
  const allowed=['provider','host','port','secure','username','password','fromName','replyTo','enabled','authMode'];
  const up=db.prepare(`INSERT INTO firm_settings (id,firmId,settingType,settingKey,settingValue,updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const tx=db.transaction(()=>{
    for(const key of allowed){ if(cfg[key]===undefined) continue;
      const value=String(cfg[key]??'');
      const existing=db.prepare("SELECT id FROM firm_settings WHERE firmId=? AND settingType='email' AND settingKey=?").get(firmId,key) as any;
      if(existing) db.prepare("UPDATE firm_settings SET settingValue=?,updatedAt=? WHERE id=?").run(value,now,existing.id);
      else up.run(uuidv4(),firmId,'email',key,value,now);
    }
  }); tx();
}
function transporterFor(firmId:string){
  const c=getConfig(firmId);
  if(String(c.enabled||'true')==='false') throw new Error('Email sending is disabled in Email Settings.');
  if(!c.host||!c.port||!c.username||!c.password) throw new Error('Email SMTP configuration is incomplete.');
  return {c,transporter:nodemailer.createTransport({host:String(c.host),port:Number(c.port),secure:String(c.secure)==='true',auth:{user:String(c.username),pass:String(c.password)}})};
}

router.get('/:firmId/config',(req:Request,res:Response)=>{try{const c=getConfig(String(req.params.firmId));const password=String(c.password||'');res.json({success:true,data:{...c,password:password?'••••••••':''}})}catch(e:any){res.status(500).json({error:e.message})}});

router.put('/:firmId/config',(req:Request,res:Response)=>{try{
  const firmId=String(req.params.firmId), b=req.body||{};
  const provider=String(b.provider||'gmail').toLowerCase();
  const presets:any={gmail:{host:'smtp.gmail.com',port:465,secure:true},outlook:{host:'smtp.office365.com',port:587,secure:false},custom:{host:String(b.host||''),port:Number(b.port||587),secure:Boolean(b.secure)}};
  if(!['gmail','outlook','custom'].includes(provider)) return res.status(400).json({error:'Invalid email provider.'});
  const p=presets[provider];
  const current=getConfig(firmId);
  const cfg={provider,host:p.host,port:p.port,secure:p.secure,username:String(b.username||'').trim(),password:b.password && !String(b.password).startsWith('••')?String(b.password):String(current.password||''),fromName:String(b.fromName||'').trim(),replyTo:String(b.replyTo||'').trim(),enabled:b.enabled!==false,authMode:'smtp'};
  if(provider==='custom'){cfg.host=String(b.host||'').trim();cfg.port=Number(b.port||587);cfg.secure=Boolean(b.secure);}
  if(!cfg.username||!cfg.password) return res.status(400).json({error:'Email login and password/app-password are required.'});
  if(!cfg.host||!Number.isFinite(cfg.port)||cfg.port<1||cfg.port>65535) return res.status(400).json({error:'Valid SMTP host and port are required.'});
  saveConfig(firmId,cfg);res.json({success:true,data:{...cfg,password:'••••••••'}});
}catch(e:any){res.status(500).json({error:e.message})}});

router.post('/:firmId/test',(req:Request,res:Response)=>{(async()=>{try{const {transporter}=transporterFor(String(req.params.firmId));await transporter.verify();res.json({success:true,data:{ok:true}})}catch(e:any){res.status(502).json({error:e?.message||'SMTP connection failed'})}})()});

function makeDocumentPdf(firmId:string,documentId:string){
  const d=db.prepare(`SELECT d.*,p.email partyEmail,p.phone partyPhone,p.address partyAddress,p.gstin partyGstin FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.id=? AND d.firmId=?`).get(documentId,firmId) as any;
  if(!d) throw new Error('Transaction not found.');
  const items=db.prepare('SELECT * FROM document_items WHERE documentId=? ORDER BY createdAt,id').all(documentId) as any[];
  const firm=db.prepare('SELECT * FROM firms WHERE id=?').get(firmId) as any;
  const doc:any=new jsPDF({unit:'pt',format:'a4'});
  const pageW=doc.internal.pageSize.getWidth(); let y=42;
  doc.setFontSize(16);doc.setFont('helvetica','bold');doc.text(String(firm?.name||'B-MAX'),40,y);y+=18;
  doc.setFontSize(10);doc.setFont('helvetica','normal');doc.text(String(firm?.address||''),40,y);y+=14;doc.text(`${firm?.city||''} ${firm?.state||''} ${firm?.pincode||''}  ${firm?.phone||''}  ${firm?.email||''}`,40,y);y+=26;
  doc.setFontSize(14);doc.setFont('helvetica','bold');doc.text(String(d.documentType||'Transaction').replace(/_/g,' ').toUpperCase(),40,y);doc.setFontSize(10);doc.setFont('helvetica','normal');doc.text(`No: ${d.documentNumber||''}`,pageW-180,y);y+=16;doc.text(`Date: ${d.documentDate||''}`,pageW-180,y);y+=22;
  doc.setFont('helvetica','bold');doc.text(`Customer / Party: ${d.partyName||'—'}`,40,y);y+=15;doc.setFont('helvetica','normal');doc.text(`Email: ${d.partyEmail||'—'}`,40,y);y+=22;
  const rows=items.map((it:any,i:number)=>[String(i+1),String(it.name||''),String(it.quantity||''),String(it.rate||it.saleRate||it.purchaseRate||''),String(it.amount||'')]);
  (doc as any).autoTable({startY:y,head:[['#','Item','Qty','Rate','Amount']],body:rows,theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});
  y=(doc as any).lastAutoTable.finalY+18;doc.setFont('helvetica','bold');doc.text(`Subtotal: ${Number(d.subtotal||0).toFixed(2)}`,pageW-210,y);y+=14;doc.text(`Tax: ${Number(d.taxAmount||0).toFixed(2)}`,pageW-210,y);y+=14;doc.text(`Paid: ${Number(d.paidAmount||0).toFixed(2)}`,pageW-210,y);y+=16;doc.setFontSize(12);doc.text(`Grand Total: ${Number(d.total||0).toFixed(2)}`,pageW-210,y);y+=18;doc.setFontSize(9);doc.setFont('helvetica','normal');doc.text(`Pending: ${Math.max(0,Number(d.total||0)-Number(d.paidAmount||0)).toFixed(2)}`,pageW-210,y);
  return {d,pdf:Buffer.from(doc.output('arraybuffer'))};
}

router.post('/:firmId/send', (req:Request,res:Response)=>{(async()=>{try{
  const firmId=String(req.params.firmId);const b=req.body||{};const to=Array.isArray(b.to)?b.to.map((x:any)=>String(x).trim()).filter(Boolean):String(b.to||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!to.length) return res.status(400).json({error:'At least one recipient email is required.'});
  if(to.some((x:string)=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) return res.status(400).json({error:'One or more recipient email addresses are invalid.'});
  const {c,transporter}=transporterFor(firmId);let attachments=Array.isArray(b.attachments)?b.attachments.map((a:any)=>({filename:String(a.filename||'attachment'),content:Buffer.from(String(a.contentBase64||''),'base64')})):[];
  let subject=String(b.subject||'B-MAX Transaction');let html=String(b.html||'');let text=String(b.text||'');
  if(b.documentId){const made=makeDocumentPdf(firmId,String(b.documentId));attachments.push({filename:`${made.d.documentNumber||'transaction'}.pdf`,content:made.pdf});if(!html)html=`<p>Dear ${made.d.partyName||'Customer'},</p><p>Please find your ${String(made.d.documentType||'transaction').replace(/_/g,' ')} attached.</p><p><b>Document:</b> ${made.d.documentNumber||''}<br/><b>Amount:</b> ₹${Number(made.d.total||0).toFixed(2)}<br/><b>Pending:</b> ₹${Math.max(0,Number(made.d.total||0)-Number(made.d.paidAmount||0)).toFixed(2)}</p><p>Regards,<br/>${c.fromName||'B-MAX'}</p>`;}
  const info=await transporter.sendMail({from:c.fromName?`"${c.fromName}" <${c.username}>`:c.username,to,subject,text:text||undefined,html:html||undefined,replyTo:c.replyTo||undefined,attachments});
  res.json({success:true,data:{messageId:info.messageId,accepted:info.accepted,rejected:info.rejected}});
}catch(e:any){res.status(502).json({error:e?.message||'Email send failed'})}})()});


function makePayslipPdf(firmId:string, payrollItemId:string){
  const item=db.prepare(`SELECT pi.*,pr.month,pr.year,pr.startDate,pr.endDate,pr.status runStatus,e.firstName,e.lastName,e.employeeCode,e.phone,e.email,e.department,e.designation,e.reportingToId,e.joiningDate,e.workLocation,e.panNumber,e.aadharNumber,e.bankAccountName,e.bankAccountNumber,e.ifscCode,e.salary,e.basicSalary,e.hra,e.allowances,e.deductions FROM payroll_items pi JOIN payroll_runs pr ON pr.id=pi.payrollRunId JOIN employees e ON e.id=pi.employeeId WHERE pi.id=? AND pr.firmId=?`).get(payrollItemId,firmId) as any;
  if(!item) throw new Error('Payroll item not found.');
  const firm=db.prepare('SELECT * FROM firms WHERE id=?').get(firmId) as any;
  const attendance=db.prepare('SELECT * FROM attendance WHERE firmId=? AND employeeId=? AND date BETWEEN ? AND ?').all(firmId,item.employeeId,item.startDate,item.endDate) as any[];
  const paidLeave=db.prepare("SELECT COALESCE(SUM(days),0) days FROM leave_requests WHERE firmId=? AND employeeId=? AND status='approved' AND isPaid=1 AND startDate<=? AND endDate>=?").get(firmId,item.employeeId,item.endDate,item.startDate) as any;
  const unpaidLeave=db.prepare("SELECT COALESCE(SUM(days),0) days FROM leave_requests WHERE firmId=? AND employeeId=? AND status='approved' AND isPaid=0 AND startDate<=? AND endDate>=?").get(firmId,item.employeeId,item.endDate,item.startDate) as any;
  const reporting=item.reportingToId?db.prepare("SELECT TRIM(COALESCE(firstName,'')||' '||COALESCE(lastName,'')) name FROM employees WHERE id=?").get(item.reportingToId) as any:null;
  const doc:any=new jsPDF({unit:'pt',format:'a4'}); const W=doc.internal.pageSize.getWidth(); let y=42;
  const money=(v:any)=>`₹${Number(v||0).toFixed(2)}`; const esc=(v:any)=>String(v??'—'); const dateOnly=(v:any)=>v?String(v).slice(0,10):'—';
  doc.setFontSize(16);doc.setFont('helvetica','bold');doc.text(String(firm?.name||'B-MAX'),40,y);y+=16;doc.setFontSize(9);doc.setFont('helvetica','normal');doc.text(String(firm?.address||''),40,y);y+=13;doc.text(`${firm?.city||''} ${firm?.state||''} ${firm?.pincode||''}  ${firm?.phone||''}  ${firm?.email||''}`,40,y);y+=24;
  doc.setFontSize(15);doc.setFont('helvetica','bold');doc.text('EMPLOYEE PAYSLIP',40,y);doc.setFontSize(10);doc.setFont('helvetica','normal');doc.text(`Payslip For: ${item.month||''}/${item.year||''}`,W-150,y);y+=20;
  const info=[['Employee Name',`${item.firstName||''} ${item.lastName||''}`],['Employee ID',item.employeeCode],['Designation',item.designation],['Department',item.department],['Reporting To',reporting?.name||'—'],['Joining Date',dateOnly(item.joiningDate)],['Mobile / Email',`${item.phone||'—'} · ${item.email||'—'}`],['Work Location',item.workLocation]];
  (doc as any).autoTable({startY:y,head:[['Employee Information','Details']],body:info,theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});y=(doc as any).lastAutoTable.finalY+14;
  (doc as any).autoTable({startY:y,head:[['Pay Period','Value']],body:[['Period',`${dateOnly(item.startDate)} → ${dateOnly(item.endDate)}`],['Payment Date',dateOnly(item.paidAt)]],theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});y=(doc as any).lastAutoTable.finalY+14;
  (doc as any).autoTable({startY:y,head:[['Attendance','Days']],body:[['Working Days',item.workingDays],['Present / Paid Days',item.presentDays],['OD Days',item.odDays],['Half Days',item.halfDays],['Absent / LOP Days',item.absentDays],['Weekly Off',item.weeklyOffDays]],theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});y=(doc as any).lastAutoTable.finalY+14;
  (doc as any).autoTable({startY:y,head:[['Leave Summary','Days']],body:[['Paid Leave',Number(paidLeave?.days||0)],['Unpaid Leave',Number(unpaidLeave?.days||0)]],theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});y=(doc as any).lastAutoTable.finalY+14;
  const gross=Number(item.basicSalary||item.salary||0)+Number(item.hra||0)+Number(item.allowances||0);
  (doc as any).autoTable({startY:y,head:[['Earnings','Amount','Deductions','Amount']],body:[['Basic Salary',money(item.basicSalary||item.salary), 'Salary Deductions',money(item.deductions)],['HRA',money(item.hra),'Unpaid Leave / LOP',money(0)],['Allowances',money(item.allowances),'Other Deductions','—'],['Gross Structure',money(gross),'Processed Deductions',money(item.deductions)]],theme:'grid',styles:{fontSize:8},headStyles:{fontSize:8}});y=(doc as any).lastAutoTable.finalY+16;doc.setFontSize(13);doc.setFont('helvetica','bold');doc.text(`NET SALARY PAID: ${money(item.netSalary)}`,W-230,y);y+=18;doc.setFontSize(8);doc.setFont('helvetica','normal');doc.text(`PAN: ${item.panNumber||'—'}   Aadhaar: ${item.aadharNumber||'—'}   Bank: ${item.bankAccountName||'—'} ${item.bankAccountNumber||''}   IFSC: ${item.ifscCode||'—'}`,40,y);
  return {item,pdf:Buffer.from(doc.output('arraybuffer'))};
}

router.post('/:firmId/payroll-payslips',(req:Request,res:Response)=>{(async()=>{try{
  const firmId=String(req.params.firmId),runId=String(req.body?.payrollRunId||'');
  if(!runId)return res.status(400).json({error:'Payroll run is required.'});
  const run=db.prepare('SELECT * FROM payroll_runs WHERE id=? AND firmId=?').get(runId,firmId) as any;if(!run)return res.status(404).json({error:'Payroll run not found.'});
  const requested=Array.isArray(req.body?.employeeIds)?req.body.employeeIds.map(String):[];
  const items=(db.prepare('SELECT id,employeeId FROM payroll_items WHERE payrollRunId=? AND status<>\'held\' ORDER BY employeeName').all(runId) as any[]).filter(x=>!requested.length||requested.includes(String(x.employeeId)));
  const {c,transporter}=transporterFor(firmId);const results:any[]=[];let sent=0,failed=0;
  for(const row of items){try{const made=makePayslipPdf(firmId,row.id);const email=String(made.item.email||'').trim();const name=`${made.item.firstName||''} ${made.item.lastName||''}`.trim()||'Employee';if(!email)throw new Error('Employee email is missing.');if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Employee email is invalid.');const info=await transporter.sendMail({from:c.fromName?`"${c.fromName}" <${c.username}>`:c.username,to:email,subject:`Payslip - ${made.item.month||''}/${made.item.year||''} - ${name}`,html:`<p>Dear ${name},</p><p>Please find your B-MAX payslip for <b>${made.item.month||''}/${made.item.year||''}</b> attached.</p><p>Net Salary: <b>₹${Number(made.item.netSalary||0).toFixed(2)}</b></p><p>Regards,<br/>${c.fromName||'B-MAX'}</p>`,replyTo:c.replyTo||undefined,attachments:[{filename:`Payslip-${made.item.employeeCode||made.item.employeeId}-${made.item.month||''}-${made.item.year||''}.pdf`,content:made.pdf}]});sent++;results.push({employeeId:made.item.employeeId,employeeName:name,email,status:'sent',messageId:info.messageId});}catch(e:any){failed++;results.push({employeeId:row.employeeId,employeeName:'',email:'',status:'failed',error:e?.message||'Email failed'});}}
  res.json({success:true,data:{sent,failed,results}});
}catch(e:any){res.status(502).json({error:e?.message||'Bulk payslip email failed'})}})()});

export default router;
