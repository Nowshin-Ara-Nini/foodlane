import Foodlane from '../foodlane';
import { requirePageRole } from '../auth-session';
export const dynamic='force-dynamic';
export default async function Seller(){await requirePageRole('seller','/seller');return <Foodlane mode="seller"/>}
