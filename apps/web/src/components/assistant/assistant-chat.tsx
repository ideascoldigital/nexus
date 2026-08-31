"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  AlertCircle,
  Bot,
  CheckCircle,
  Loader2,
  Send,
  User,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AssistantChatProps<TConfig> {
  type: "agent" | "skill" | "code";
  onConfigGenerated?: (config: TConfig) => void;
  placeholder?: string;
  initialMessage?: string;
}

export function AssistantChat<TConfig = unknown>({
  type,
  onConfigGenerated,
  placeholder,
  initialMessage,
}: AssistantChatProps<TConfig>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [parsedConfig, setParsedConfig] = useState<TConfig | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const storageKey = `assistant-chat-${type}`;

  // Load messages from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          setMessages(parsed);
        }
      } catch (error) {
        console.error("Failed to load conversation from localStorage:", error);
      }
      setIsInitialized(true);
    }
  }, [storageKey]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      try {
        if (messages.length > 0) {
          localStorage.setItem(storageKey, JSON.stringify(messages));
        }
      } catch (error) {
        console.error("Failed to save conversation to localStorage:", error);
      }
    }
  }, [messages, isInitialized, storageKey]);

  // Send initial message if provided and no messages exist
  useEffect(() => {
    if (isInitialized && initialMessage && messages.length === 0) {
      sendMessage(initialMessage);
    }
  }, [initialMessage, isInitialized, messages.length]);

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message,
          history: messages,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.details || error.error || "Failed to send message");
      }

      return res.json();
    },
    onSuccess: (data) => {
      const assistantMessage: Message = {
        role: "assistant",
        content: data.message,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      // Try to parse configuration
      tryParseConfig(data.message);
    },
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, chatMutation.isPending]);

  const parseMutation = useMutation({
    mutationFn: async (response: string) => {
      const res = await fetch("/api/assistant/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: type === "code" ? "agent" : type,
          response,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to parse configuration");
      }

      return res.json();
    },
    onSuccess: (data) => {
      if (data.config) {
        setParsedConfig(data.config);
        if (onConfigGenerated) {
          onConfigGenerated(data.config);
        }
      }
    },
  });

  const sendMessage = (msg?: string) => {
    const messageToSend = msg || input.trim();
    if (!messageToSend || chatMutation.isPending) return;

    const userMessage: Message = {
      role: "user",
      content: messageToSend,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    chatMutation.mutate(messageToSend);
  };

  const tryParseConfig = (response: string) => {
    if (type !== "code") {
      parseMutation.mutate(response);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setParsedConfig(null);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(storageKey);
      } catch (error) {
        console.error("Failed to clear conversation from localStorage:", error);
      }
    }
    // Send initial message again if provided
    if (initialMessage) {
      setTimeout(() => sendMessage(initialMessage), 100);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background rounded-lg border overflow-hidden">
      {/* Header with Clear Button */}
      {messages.length > 0 && (
        <div className="flex shrink-0 items-center justify-between px-4 py-2 border-b bg-muted/30">
          <p className="text-xs text-muted-foreground">
            {messages.length} message{messages.length !== 1 ? "s" : ""} in conversation
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearConversation}
            className="h-7 text-xs gap-1"
          >
            Clear
          </Button>
        </div>
      )}

      {/* Messages - Scrollable Area */}
      <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0 p-4">
        <div className="space-y-4 pb-4">
          {messages.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="py-8 text-center">
                <Bot className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-sm text-muted-foreground">
                  {placeholder ||
                    `Start a conversation to configure your ${type === "agent" ? "agent" : "skill"}`}
                </p>
              </CardContent>
            </Card>
          )}

          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex gap-3 ${
                message.role === "user" ? "justify-end" : ""
              }`}
            >
              {message.role === "assistant" && (
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </AvatarFallback>
                </Avatar>
              )}
              
              <Card
                className={`max-w-[80%] break-words ${
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : ""
                }`}
              >
                <CardContent className="p-3">
                  {message.role === "assistant" ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                      <ReactMarkdown
                        components={{
                          code({
                            className,
                            children,
                            ...props
                          }: React.HTMLAttributes<HTMLElement>) {
                            const match = /language-(\w+)/.exec(className || "");
                            const inline = !match;
                            return !inline && match ? (
                              <SyntaxHighlighter
                                style={oneDark}
                                language={match[1]}
                                PreTag="div"
                              >
                                {String(children).replace(/\n$/, "")}
                              </SyntaxHighlighter>
                            ) : (
                              <code className={className} {...props}>
                                {children}
                              </code>
                            );
                          },
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                  )}
                </CardContent>
              </Card>

              {message.role === "user" && (
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="bg-muted">
                    <User className="h-4 w-4" />
                  </AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}

          {chatMutation.isPending && (
            <div className="flex gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </AvatarFallback>
              </Avatar>
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Thinking...
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {chatMutation.isError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {chatMutation.error?.message || "Failed to send message"}
              </AlertDescription>
            </Alert>
          )}

          {parsedConfig && onConfigGenerated && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>
                Configuration extracted! You can now save it.
              </AlertDescription>
            </Alert>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input - Fixed at Bottom */}
      <div className="shrink-0 border-t bg-background p-4">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={
              placeholder ||
              `Ask about ${type === "agent" ? "agent" : "skill"} configuration...`
            }
            disabled={chatMutation.isPending}
            className="flex-1"
          />
          <Button
            onClick={() => sendMessage()}
            disabled={!input.trim() || chatMutation.isPending}
            size="icon"
          >
            {chatMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
