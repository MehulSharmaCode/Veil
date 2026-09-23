// zod, configured for the MV3 CSP: no JIT (it would try `new Function`, which the CSP forbids).
import { z } from 'zod';

z.config({ jitless: true });

export { z };
