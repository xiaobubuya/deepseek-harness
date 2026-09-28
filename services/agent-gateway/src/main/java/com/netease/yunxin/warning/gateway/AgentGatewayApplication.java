package com.netease.yunxin.warning.gateway;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(GatewayProperties.class)
public class AgentGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(AgentGatewayApplication.class, args);
    }
}
