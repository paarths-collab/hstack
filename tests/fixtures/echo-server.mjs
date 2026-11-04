import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

if (process.env.BUFFER_API_KEY) throw new Error('Unexpected credential inheritance');
if (process.env.PYTHON_DOTENV_DISABLED !== '1') throw new Error('Unexpected dotenv configuration');
const server = new McpServer({name:'fixture-only',version:'0'});
server.registerTool('get_record',{inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>({
 content:[{type:'text',text:'synthetic record'}],_meta:{fixture:true}
}));
await server.connect(new StdioServerTransport());
