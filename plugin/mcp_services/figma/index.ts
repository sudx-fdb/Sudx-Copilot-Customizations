#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import apiClientInstance, { setFigmaToken } from "./src/api/ApiBase.js";
import { zodToJsonSchema } from 'zod-to-json-schema';

const responseToString = (response: any) => {
    return {
        content: [{ type: "text", text: JSON.stringify(response) }]
    };
}

// Common schema definitions
const FileKeySchema = z.object({
    fileKey: z.string().describe("The file key to use for the operation")
});

const FigmaGetCommentsArgumentsSchema = FileKeySchema.extend({
    as_md: z.boolean().describe("Whether to return the comments as markdown").default(false),
});

const PostCommentArgumentsSchema = FileKeySchema.extend({
    message: z.string().describe("The text contents of the comment to post"),
    comment_id: z.string().optional().describe("The ID of the comment to reply to, if any"),
    client_meta: z.any().optional().describe("The position where to place the comment")
});

const DeleteCommentArgumentsSchema = FileKeySchema.extend({
    commentId: z.string().describe("The ID of the comment to delete")
});

const GetCommentReactionsArgumentsSchema = FileKeySchema.extend({
    commentId: z.string().describe("The ID of the comment to get reactions for"),
    cursor: z.string().optional().describe("Cursor for pagination")
});

const PostCommentReactionArgumentsSchema = FileKeySchema.extend({
    commentId: z.string().describe("The ID of the comment to add a reaction to"),
    emoji: z.string().describe("The emoji to react with")
});

const DeleteCommentReactionArgumentsSchema = FileKeySchema.extend({
    commentId: z.string().describe("The ID of the comment to delete a reaction from"),
    emoji: z.string().describe("The emoji to remove")
});

const GetFileNodesArgumentsSchema = FileKeySchema.extend({
    ids: z.string().describe("A comma separated list of node IDs to retrieve and convert"),
    version: z.string().optional().describe("A specific version ID to get"),
    depth: z.number().optional().describe("Positive integer representing how deep into the node tree to traverse"),
    geometry: z.string().optional().describe("Set to \"paths\" to export vector data"),
    plugin_data: z.string().optional().describe("A comma separated list of plugin IDs and/or the string \"shared\"")
});

const GetFileVersionsArgumentsSchema = FileKeySchema.extend({
    page_size: z.number().optional().describe("The number of items returned in a page of the response"),
    before: z.number().optional().describe("A version ID for one of the versions in the history. Gets versions before this ID"),
    after: z.number().optional().describe("A version ID for one of the versions in the history. Gets versions after this ID")
});

const GetImagesArgumentsSchema = FileKeySchema.extend({
    ids: z.string().describe("A comma separated list of node IDs to render"),
    version: z.string().optional().describe("A specific version ID to get"),
    scale: z.number().optional().describe("A number between 0.01 and 4, the image scaling factor"),
    format: z.enum(["jpg", "png", "svg", "pdf"]).optional().describe("A string enum for the image output format"),
    svg_outline_text: z.boolean().optional().describe("Whether text elements are rendered as outlines (vector paths) or as <text> elements in SVGs"),
    svg_include_id: z.boolean().optional().describe("Whether to include id attributes for all SVG elements"),
    svg_include_node_id: z.boolean().optional().describe("Whether to include node id attributes for all SVG elements"),
    svg_simplify_stroke: z.boolean().optional().describe("Whether to simplify inside/outside strokes and use stroke attribute if possible"),
    contents_only: z.boolean().optional().describe("Whether content that overlaps the node should be excluded from rendering"),
    use_absolute_bounds: z.boolean().optional().describe("Use the full dimensions of the node regardless of whether or not it is cropped")
});

const GetTeamProjectsArgumentsSchema = z.object({
    teamId: z.string().describe("The ID of the team to get projects for")
});

const GetProjectFilesArgumentsSchema = z.object({
    projectId: z.string().describe("The ID of the project to get files for"),
    branch_data: z.boolean().optional().describe("Returns branch metadata in the response")
});

const GetTeamComponentsArgumentsSchema = z.object({
    teamId: z.string().describe("The ID of the team to get components for"),
    page_size: z.number().optional().describe("Number of items to return in a paged list of results"),
    after: z.number().optional().describe("Cursor indicating which id after which to start retrieving components for"),
    before: z.number().optional().describe("Cursor indicating which id before which to start retrieving components for")
});

const GetTeamComponentSetsArgumentsSchema = z.object({
    teamId: z.string().describe("The ID of the team to get component sets for"),
    page_size: z.number().optional().describe("Number of items to return in a paged list of results"),
    after: z.number().optional().describe("Cursor indicating which id after which to start retrieving component sets for"),
    before: z.number().optional().describe("Cursor indicating which id before which to start retrieving component sets for")
});

const GetTeamStylesArgumentsSchema = z.object({
    teamId: z.string().describe("The ID of the team to get styles for"),
    page_size: z.number().optional().describe("Number of items to return in a paged list of results"),
    after: z.number().optional().describe("Cursor indicating which id after which to start retrieving styles for"),
    before: z.number().optional().describe("Cursor indicating which id before which to start retrieving styles for")
});

const GetComponentArgumentsSchema = z.object({
    key: z.string().describe("The key of the component to get")
});

const GetComponentSetArgumentsSchema = z.object({
    key: z.string().describe("The key of the component set to get")
});

const GetStyleArgumentsSchema = z.object({
    key: z.string().describe("The key of the style to get")
});

const GetFileArgumentsSchema = FileKeySchema.extend({
    version: z.string().optional().describe("A specific version ID to get"),
    ids: z.string().optional().describe("Comma separated list of nodes that you care about in the document"),
    depth: z.number().optional().describe("Positive integer representing how deep into the document tree to traverse"),
    geometry: z.string().optional().describe("Set to \"paths\" to export vector data"),
    plugin_data: z.string().optional().describe("A comma separated list of plugin IDs and/or the string \"shared\""),
    branch_data: z.boolean().optional().describe("Returns branch metadata for the requested file")
});

// Add these webhook schemas
const PostWebhookArgumentsSchema = z.object({
    event_type: z.string().describe("An enum representing the possible events that a webhook can subscribe to"),
    team_id: z.string().describe("Team id to receive updates about"),
    endpoint: z.string().describe("The HTTP endpoint that will receive a POST request when the event triggers"),
    passcode: z.string().describe("String that will be passed back to your webhook endpoint to verify that it is being called by Figma"),
    status: z.string().optional().describe("State of the webhook, including any error state it may be in"),
    description: z.string().optional().describe("User provided description or name for the webhook")
});

const GetWebhookArgumentsSchema = z.object({
    webhook_id: z.string().describe("The ID of the webhook to get")
});

const UpdateWebhookArgumentsSchema = z.object({
    webhook_id: z.string().describe("The ID of the webhook to update"),
    endpoint: z.string().optional().describe("The HTTP endpoint that will receive a POST request when the event triggers"),
    passcode: z.string().optional().describe("String that will be passed back to your webhook endpoint to verify that it is being called by Figma"),
    status: z.string().optional().describe("State of the webhook, including any error state it may be in"),
    description: z.string().optional().describe("User provided description or name for the webhook")
});

const DeleteWebhookArgumentsSchema = z.object({
    webhook_id: z.string().describe("The ID of the webhook to delete")
});

const GetTeamWebhooksArgumentsSchema = z.object({
    team_id: z.string().describe("The ID of the team to get webhooks for")
});

// Library analytics schemas
const GetLibraryAnalyticsComponentUsagesArgumentsSchema = FileKeySchema.extend({
    cursor: z.string().optional().describe("Cursor indicating what page of data to fetch"),
    group_by: z.enum(["component", "file"]).describe("A dimension to group returned analytics data by")
});

const GetLibraryAnalyticsStyleUsagesArgumentsSchema = FileKeySchema.extend({
    cursor: z.string().optional().describe("Cursor indicating what page of data to fetch"),
    group_by: z.enum(["style", "file"]).describe("A dimension to group returned analytics data by")
});

const GetLibraryAnalyticsVariableUsagesArgumentsSchema = FileKeySchema.extend({
    cursor: z.string().optional().describe("Cursor indicating what page of data to fetch"),
    group_by: z.enum(["variable", "file"]).describe("A dimension to group returned analytics data by")
});

// Add a utility function to help with conversion
function convertZodToJsonSchema(schema: z.ZodType<any>) {
  const jsonSchema = zodToJsonSchema(schema);
  return {
    ...jsonSchema
  };
}

// Create server instance
const server = new Server(
    {
        name: "mcp_figma",
        version: "0.6.2"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "figma_get_me",
                description: "Get the current user",
                inputSchema: {
                    properties: {},
                    required: [],
                    type: "object",
                }
            },
            {
                name: "figma_get_file",
                description: "Get a Figma file by key",
                inputSchema: convertZodToJsonSchema(GetFileArgumentsSchema),
            },
            {
                name: "figma_get_file_nodes",
                description: "Get specific nodes from a Figma file",
                inputSchema: convertZodToJsonSchema(GetFileNodesArgumentsSchema),
            },
            {
                name: "figma_get_images",
                description: "Render images from a Figma file",
                inputSchema: convertZodToJsonSchema(GetImagesArgumentsSchema),
            },
            {
                name: "figma_get_image_fills",
                description: "Get image fills in a Figma file",
                inputSchema: convertZodToJsonSchema(FileKeySchema),
            },
            {
                name: "figma_get_file_versions",
                description: "Get version history of a Figma file",
                inputSchema: convertZodToJsonSchema(GetFileVersionsArgumentsSchema),
            },
            {
                name: "figma_get_comments",
                description: "Get comments in a Figma file",
                inputSchema: convertZodToJsonSchema(FigmaGetCommentsArgumentsSchema),
            },
            {
                name: "figma_post_comment",
                description: "Add a comment to a Figma file",
                inputSchema: convertZodToJsonSchema(PostCommentArgumentsSchema),
            },
            {
                name: "figma_delete_comment",
                description: "Delete a comment from a Figma file",
                inputSchema: convertZodToJsonSchema(DeleteCommentArgumentsSchema),
            },
            {
                name: "figma_get_comment_reactions",
                description: "Get reactions for a comment",
                inputSchema: convertZodToJsonSchema(GetCommentReactionsArgumentsSchema),
            },
            {
                name: "figma_post_comment_reaction",
                description: "Add a reaction to a comment",
                inputSchema: convertZodToJsonSchema(PostCommentReactionArgumentsSchema),
            },
            {
                name: "figma_delete_comment_reaction",
                description: "Delete a reaction from a comment",
                inputSchema: convertZodToJsonSchema(DeleteCommentReactionArgumentsSchema),
            },
            {
                name: "figma_get_team_projects",
                description: "Get projects in a team",
                inputSchema: convertZodToJsonSchema(GetTeamProjectsArgumentsSchema),
            },
            {
                name: "figma_get_project_files",
                description: "Get files in a project",
                inputSchema: convertZodToJsonSchema(GetProjectFilesArgumentsSchema),
            },
            {
                name: "figma_get_team_components",
                description: "Get components in a team",
                inputSchema: convertZodToJsonSchema(GetTeamComponentsArgumentsSchema),
            },
            {
                name: "figma_get_file_components",
                description: "Get components in a file",
                inputSchema: convertZodToJsonSchema(FileKeySchema),
            },
            {
                name: "figma_get_component",
                description: "Get a component by key",
                inputSchema: convertZodToJsonSchema(GetComponentArgumentsSchema),
            },
            {
                name: "figma_get_team_component_sets",
                description: "Get component sets in a team",
                inputSchema: convertZodToJsonSchema(GetTeamComponentSetsArgumentsSchema),
            },
            {
                name: "figma_get_file_component_sets",
                description: "Get component sets in a file",
                inputSchema: convertZodToJsonSchema(FileKeySchema),
            },
            {
                name: "figma_get_component_set",
                description: "Get a component set by key",
                inputSchema: convertZodToJsonSchema(GetComponentSetArgumentsSchema),
            },
            {
                name: "figma_get_team_styles",
                description: "Get styles in a team",
                inputSchema: convertZodToJsonSchema(GetTeamStylesArgumentsSchema),
            },
            {
                name: "figma_get_file_styles",
                description: "Get styles in a file",
                inputSchema: convertZodToJsonSchema(FileKeySchema),
            },
            {
                name: "figma_get_style",
                description: "Get a style by key",
                inputSchema: convertZodToJsonSchema(GetStyleArgumentsSchema),
            },
            // Add these webhook tools
            {
                name: "figma_post_webhook",
                description: "Create a webhook",
                inputSchema: convertZodToJsonSchema(PostWebhookArgumentsSchema),
            },
            {
                name: "figma_get_webhook",
                description: "Get a webhook by ID",
                inputSchema: convertZodToJsonSchema(GetWebhookArgumentsSchema),
            },
            {
                name: "figma_update_webhook",
                description: "Update a webhook",
                inputSchema: convertZodToJsonSchema(UpdateWebhookArgumentsSchema),
            },
            {
                name: "figma_delete_webhook",
                description: "Delete a webhook",
                inputSchema: convertZodToJsonSchema(DeleteWebhookArgumentsSchema),
            },
            {
                name: "figma_get_team_webhooks",
                description: "Get webhooks for a team",
                inputSchema: convertZodToJsonSchema(GetTeamWebhooksArgumentsSchema),
            },
            // Add library analytics tools
            {
                name: "figma_get_library_analytics_component_usages",
                description: "Get library analytics component usage data",
                inputSchema: convertZodToJsonSchema(GetLibraryAnalyticsComponentUsagesArgumentsSchema),
            },
            {
                name: "figma_get_library_analytics_style_usages",
                description: "Get library analytics style usage data",
                inputSchema: convertZodToJsonSchema(GetLibraryAnalyticsStyleUsagesArgumentsSchema),
            },
            {
                name: "figma_get_library_analytics_variable_usages",
                description: "Get library analytics variable usage data",
                inputSchema: convertZodToJsonSchema(GetLibraryAnalyticsVariableUsagesArgumentsSchema),
            }
        ]
    };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "figma_get_me":
                const userResponse = await apiClientInstance.v1.getMe();
                return responseToString(userResponse.data);

            case "figma_get_file":
                const { fileKey, ...fileQueryParams } = GetFileArgumentsSchema.parse(args);
                const fileResponse = await apiClientInstance.v1.getFile(fileKey, fileQueryParams);
                return responseToString(fileResponse.data);

            case "figma_get_file_nodes":
                const { fileKey: nodesFileKey, ...nodesQueryParams } = GetFileNodesArgumentsSchema.parse(args);
                const nodesResponse = await apiClientInstance.v1.getFileNodes(nodesFileKey, nodesQueryParams);
                return responseToString(nodesResponse.data);

            case "figma_get_images":
                const { fileKey: imagesFileKey, ...imagesQueryParams } = GetImagesArgumentsSchema.parse(args);
                const imagesResponse = await apiClientInstance.v1.getImages(imagesFileKey, imagesQueryParams);
                return responseToString(imagesResponse.data);

            case "figma_get_image_fills":
                const { fileKey: fillsFileKey } = FileKeySchema.parse(args);
                const fillsResponse = await apiClientInstance.v1.getImageFills(fillsFileKey);
                return responseToString(fillsResponse.data);

            case "figma_get_file_versions":
                const { fileKey: versionsFileKey, ...versionsQueryParams } = GetFileVersionsArgumentsSchema.parse(args);
                const versionsResponse = await apiClientInstance.v1.getFileVersions(versionsFileKey, versionsQueryParams);
                return responseToString(versionsResponse.data);

            case "figma_get_comments":
                const commentsParams = FigmaGetCommentsArgumentsSchema.parse(args);
                const commentsResponse = await apiClientInstance.v1.getComments(commentsParams.fileKey, { as_md: commentsParams.as_md });
                return responseToString(commentsResponse.data);

            case "figma_post_comment":
                const { fileKey: commentFileKey, message, comment_id, client_meta } = PostCommentArgumentsSchema.parse(args);
                const postCommentResponse = await apiClientInstance.v1.postComment(commentFileKey, {
                    message,
                    comment_id,
                    client_meta
                });
                return responseToString(postCommentResponse.data);

            case "figma_delete_comment":
                const { fileKey: deleteCommentFileKey, commentId } = DeleteCommentArgumentsSchema.parse(args);
                const deleteCommentResponse = await apiClientInstance.v1.deleteComment(deleteCommentFileKey, commentId);
                return responseToString(deleteCommentResponse.data);

            case "figma_get_comment_reactions":
                const { fileKey: reactionsFileKey, commentId: reactionsCommentId, cursor } = GetCommentReactionsArgumentsSchema.parse(args);
                const reactionsResponse = await apiClientInstance.v1.getCommentReactions(reactionsFileKey, reactionsCommentId, { cursor });
                return responseToString(reactionsResponse.data);

            case "figma_post_comment_reaction":
                const { fileKey: postReactionFileKey, commentId: postReactionCommentId, emoji } = PostCommentReactionArgumentsSchema.parse(args);
                const postReactionResponse = await apiClientInstance.v1.postCommentReaction(postReactionFileKey, postReactionCommentId, { emoji });
                return responseToString(postReactionResponse.data);

            case "figma_delete_comment_reaction":
                const { fileKey: deleteReactionFileKey, commentId: deleteReactionCommentId, emoji: deleteEmoji } = DeleteCommentReactionArgumentsSchema.parse(args);
                const deleteReactionResponse = await apiClientInstance.v1.deleteCommentReaction(deleteReactionFileKey, deleteReactionCommentId, { emoji: deleteEmoji });
                return responseToString(deleteReactionResponse.data);

            case "figma_get_team_projects":
                const { teamId } = GetTeamProjectsArgumentsSchema.parse(args);
                const teamProjectsResponse = await apiClientInstance.v1.getTeamProjects(teamId);
                return responseToString(teamProjectsResponse.data);

            case "figma_get_project_files":
                const { projectId, branch_data } = GetProjectFilesArgumentsSchema.parse(args);
                const projectFilesResponse = await apiClientInstance.v1.getProjectFiles(projectId, { branch_data });
                return responseToString(projectFilesResponse.data);

            case "figma_get_team_components":
                const { teamId: componentsTeamId, ...componentsQueryParams } = GetTeamComponentsArgumentsSchema.parse(args);
                const teamComponentsResponse = await apiClientInstance.v1.getTeamComponents(componentsTeamId, componentsQueryParams);
                return responseToString(teamComponentsResponse.data);

            case "figma_get_file_components":
                const { fileKey: componentsFileKey } = FileKeySchema.parse(args);
                const fileComponentsResponse = await apiClientInstance.v1.getFileComponents(componentsFileKey);
                return responseToString(fileComponentsResponse.data);

            case "figma_get_component":
                const { key: componentKey } = GetComponentArgumentsSchema.parse(args);
                const componentResponse = await apiClientInstance.v1.getComponent(componentKey);
                return responseToString(componentResponse.data);

            case "figma_get_team_component_sets":
                const { teamId: componentSetsTeamId, ...componentSetsQueryParams } = GetTeamComponentSetsArgumentsSchema.parse(args);
                const teamComponentSetsResponse = await apiClientInstance.v1.getTeamComponentSets(componentSetsTeamId, componentSetsQueryParams);
                return responseToString(teamComponentSetsResponse.data);

            case "figma_get_file_component_sets":
                const { fileKey: componentSetsFileKey } = FileKeySchema.parse(args);
                const fileComponentSetsResponse = await apiClientInstance.v1.getFileComponentSets(componentSetsFileKey);
                return responseToString(fileComponentSetsResponse.data);

            case "figma_get_component_set":
                const { key: componentSetKey } = GetComponentSetArgumentsSchema.parse(args);
                const componentSetResponse = await apiClientInstance.v1.getComponentSet(componentSetKey);
                return responseToString(componentSetResponse.data);

            case "figma_get_team_styles":
                const { teamId: stylesTeamId, ...stylesQueryParams } = GetTeamStylesArgumentsSchema.parse(args);
                const teamStylesResponse = await apiClientInstance.v1.getTeamStyles(stylesTeamId, stylesQueryParams);
                return responseToString(teamStylesResponse.data);

            case "figma_get_file_styles":
                const { fileKey: stylesFileKey } = FileKeySchema.parse(args);
                const fileStylesResponse = await apiClientInstance.v1.getFileStyles(stylesFileKey);
                return responseToString(fileStylesResponse.data);

            case "figma_get_style":
                const { key: styleKey } = GetStyleArgumentsSchema.parse(args);
                const styleResponse = await apiClientInstance.v1.getStyle(styleKey);
                return responseToString(styleResponse.data);

            // V2 API methods
            case "figma_post_webhook":
                const webhookData = PostWebhookArgumentsSchema.parse(args);
                const postWebhookResponse = await apiClientInstance.v2.postWebhook(webhookData as any);
                return responseToString(postWebhookResponse.data);

            case "figma_get_webhook":
                const { webhook_id } = GetWebhookArgumentsSchema.parse(args);
                const getWebhookResponse = await apiClientInstance.v2.getWebhook(webhook_id);
                return responseToString(getWebhookResponse.data);

            case "figma_update_webhook":
                const { webhook_id: updateWebhookId, ...updateWebhookData } = UpdateWebhookArgumentsSchema.parse(args);
                const updateWebhookResponse = await apiClientInstance.v2.putWebhook(updateWebhookId, updateWebhookData as any);
                return responseToString(updateWebhookResponse.data);

            case "figma_delete_webhook":
                const { webhook_id: deleteWebhookId } = DeleteWebhookArgumentsSchema.parse(args);
                const deleteWebhookResponse = await apiClientInstance.v2.deleteWebhook(deleteWebhookId);
                return responseToString(deleteWebhookResponse.data);

            case "figma_get_team_webhooks":
                const { team_id } = GetTeamWebhooksArgumentsSchema.parse(args);
                const getTeamWebhooksResponse = await apiClientInstance.v2.getTeamWebhooks(team_id);
                return responseToString(getTeamWebhooksResponse.data);

            // Library analytics methods
            case "figma_get_library_analytics_component_usages":
                const { fileKey: componentsAnalyticsFileKey, ...componentsAnalyticsParams } = GetLibraryAnalyticsComponentUsagesArgumentsSchema.parse(args);
                const getLibraryAnalyticsComponentsResponse = await apiClientInstance.v1.getLibraryAnalyticsComponentUsages(componentsAnalyticsFileKey, componentsAnalyticsParams);
                return responseToString(getLibraryAnalyticsComponentsResponse.data);

            case "figma_get_library_analytics_style_usages":
                const { fileKey: stylesAnalyticsFileKey, ...stylesAnalyticsParams } = GetLibraryAnalyticsStyleUsagesArgumentsSchema.parse(args);
                const getLibraryAnalyticsStylesResponse = await apiClientInstance.v1.getLibraryAnalyticsStyleUsages(stylesAnalyticsFileKey, stylesAnalyticsParams);
                return responseToString(getLibraryAnalyticsStylesResponse.data);

            case "figma_get_library_analytics_variable_usages":
                const { fileKey: variablesAnalyticsFileKey, ...variablesAnalyticsParams } = GetLibraryAnalyticsVariableUsagesArgumentsSchema.parse(args);
                const getLibraryAnalyticsVariablesResponse = await apiClientInstance.v1.getLibraryAnalyticsVariableUsages(variablesAnalyticsFileKey, variablesAnalyticsParams);
                return responseToString(getLibraryAnalyticsVariablesResponse.data);

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

    } catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(
                `Invalid arguments: ${error.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join(", ")}`
            );
        }
        
        // Add detailed error logging
        const err = error as any;
        console.error("Error details:", {
            message: err.message,
            stack: err.stack,
            response: err.response?.data || null,
            status: err.response?.status || null,
            headers: err.response?.headers || null,
            name: err.name,
            fullError: JSON.stringify(err, Object.getOwnPropertyNames(err), 2)
        });
        
        throw new Error(`Error executing tool ${name}: ${err.message}${err.response?.data ? ` - Response: ${JSON.stringify(err.response.data)}` : ''}`);
    }
});

// Start the server
async function main() {
    try {
        // Parse command line arguments
        const args = process.argv.slice(2);
        let figmaToken;

        // Look for --token or -t flag
        for (let i = 0; i < args.length; i++) {
            if ((args[i] === '--figma-token' || args[i] === '-ft') && i + 1 < args.length) {
                figmaToken = args[i + 1];
                break;
            }
        }

        // Check for token in environment variable if not provided in args
        if (!figmaToken) {
            figmaToken = process.env.FIGMA_API_KEY;
        }

        // Set the token if provided
        if (figmaToken) {
            setFigmaToken(figmaToken);
        } else {
            console.error("Warning: No Figma API token provided. Set FIGMA_API_KEY environment variable or use --figma-token flag.");
            throw new Error("No Figma API token provided. Set FIGMA_API_KEY environment variable or use --figma-token flag.");
        }

        console.error("Starting MCP Figma Server...");
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("MCP Figma Server running on stdio");
    } catch (error) {
        console.error("Error during startup:", error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
