import { Router, Request, Response } from 'express';

const router = Router();
export const INDIA_STATES = [
  'Andaman and Nicobar Islands','Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chandigarh','Chhattisgarh','Dadra and Nagar Haveli and Daman and Diu','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Jammu & Kashmir','Jharkhand','Karnataka','Kerala','Ladakh','Lakshadweep','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Puducherry','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal'
];

// Offline PIN-prefix resolver. It deliberately returns null when a prefix is
// ambiguous rather than guessing a state. Users can always select the state.
const PREFIXES: Array<[RegExp,string]> = [
 [/^11/,'Delhi'],[/^(12|13)/,'Haryana'],[/^(14|15|16)/,'Punjab'],[/^17/,'Himachal Pradesh'],[/^(18|19)/,'Jammu & Kashmir'],
 [/^(20|21|22|23|24|25|26|27|28)/,'Uttar Pradesh'],[/^(30|31|32|33|34)/,'Rajasthan'],[/^(36|37|38|39)/,'Gujarat'],
 [/^(40|41|42|43|44)/,'Maharashtra'],[/^(45|46|47|48|49)/,'Madhya Pradesh'],[/^(50|51|52|53)/,'Telangana'],
 [/^(56|57|58|59)/,'Karnataka'],[/^(60|61|62|63|64)/,'Tamil Nadu'],[/^(67|68|69)/,'Kerala'],[/^(70|71|72|73|74)/,'West Bengal'],
 [/^(75|76|77)/,'Odisha'],[/^78/,'Assam'],[/^79/,'Arunachal Pradesh'],[/^(80|81|82|83|84|85)/,'Bihar'],[/^49/,'Chhattisgarh'],
 [/^32/,'Rajasthan'],[/^54/,'Uttar Pradesh'],[/^55/,'Uttar Pradesh'],[/^79/,'Arunachal Pradesh']
];
router.get('/states', (_req: Request, res: Response) => res.json({success:true,data:INDIA_STATES}));
router.get('/pincode/:pincode', (req: Request, res: Response) => {
  const pin=String(req.params.pincode||'').replace(/\D/g,'').slice(0,6);
  if(pin.length!==6) return res.status(400).json({error:'Pincode must be 6 digits'});
  const match=PREFIXES.find(([re])=>re.test(pin));
  res.json({success:true,data:{pincode:pin,state:match?.[1]||null,matched:!!match}});
});
export default router;



