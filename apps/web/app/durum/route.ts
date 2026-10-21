import { safeReturnPath } from "@arilla/core/maintenance";
import { MAINTENANCE_HEADERS, maintenanceDocument } from "@arilla/core/maintenance-document";
import { readSystemStatus } from "@arilla/core/maintenance-service";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return new Response(
    maintenanceDocument({
      status: await readSystemStatus(),
      returnPath: safeReturnPath(url.searchParams.get("next")),
      autoReturn: url.searchParams.has("next"),
    }),
    { headers: MAINTENANCE_HEADERS },
  );
}
